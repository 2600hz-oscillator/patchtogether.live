// packages/web/src/lib/audio/midi-access.ts
//
// THE ONE PLACE WE ASK FOR WEB MIDI — and the one place that can explain a NO.
//
// ⚠ WHY THIS EXISTS (owner-reported, 2026-08-07). On a FRESH origin
// (dev.patchtogether.live, never granted anything) both "Connect MIDI…"
// buttons were dead: no prompt, no console error, no change on the card. The
// app was innocent — `navigator.requestMIDIAccess` was present, the context was
// secure and cross-origin isolated, and `permissions.query({name:'midi'})`
// reported `prompt`. Chromium was simply not SHOWING the prompt: it quiets
// permission requests on origins with little interaction history, surfacing a
// small address-bar icon instead of a modal. Granting an unrelated permission
// (the mic, via AUDIO IN) gave the origin real interaction, after which MIDI
// prompted normally.
//
// So the defect was never "MIDI is broken". It was that a suppressed prompt and
// a broken button are INDISTINGUISHABLE from the UI — the third instance of
// that class in one day (ES-9's dead Connect, the bridge's silent `busy`, this).
// Every new user of a new origin hits it exactly once, and has no way to know
// what to do.
//
// This module turns all three outcomes into a NAMED result:
//   'granted'      — access, use it
//   'denied'       — the browser said no (rejected); the user can undo it
//   'no-prompt'    — nothing settled inside the budget: the prompt was almost
//                    certainly suppressed. The ONE case that used to be silent.
//   'unsupported'  — no Web MIDI in this browser at all
//
// ⚠ The 'no-prompt' verdict is a HEURISTIC, not a browser signal — there is no
// API that reports "I quietly suppressed your prompt". It is a timeout, so it
// can also fire for a user who simply takes a long time to answer a REAL
// prompt. That is why the copy says "if you did not see a prompt" rather than
// asserting one was suppressed, and why the pending request is NOT cancelled:
// if the user answers late, `onLateResolve` still delivers the access.

/** Milliseconds to wait before concluding no prompt appeared.
 *
 *  Chosen to sit well ABOVE a normal grant (a modal that is actually shown gets
 *  answered in a second or two by someone who clicked the button on purpose)
 *  and well BELOW the point a user decides the app is broken. If it fires while
 *  a real prompt is still open, nothing is lost — the late answer is still
 *  honoured via `onLateResolve`. */
export const MIDI_PROMPT_TIMEOUT_MS = 8000;

export type MidiAccessOutcome =
  | { kind: 'granted'; access: MIDIAccessLike }
  | { kind: 'denied'; message: string }
  | { kind: 'no-prompt' }
  | { kind: 'unsupported' };

/** The slice of MIDIAccess this app uses. Kept structural so tests can fake it
 *  and so we do not depend on lib.dom's Web MIDI typings being present. */
export interface MIDIAccessLike {
  inputs: Map<string, { name?: string | null; state?: string }>;
  outputs: Map<string, { name?: string | null; state?: string }>;
  onstatechange: ((e?: unknown) => void) | null;
}

interface NavigatorWithMidi {
  requestMIDIAccess?: (opts?: { sysex?: boolean }) => Promise<MIDIAccessLike>;
}

/** Is Web MIDI callable at all in this browser? */
export function webMidiSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof (navigator as unknown as NavigatorWithMidi).requestMIDIAccess === 'function';
}

/**
 * Ask for Web MIDI and ALWAYS return a nameable outcome.
 *
 * MUST be called synchronously from a user gesture — an `await` before this
 * point spends the user activation and Chromium will refuse to prompt. Callers
 * are click handlers for exactly that reason; do not add an await above it.
 *
 * `onLateResolve` receives the access if the user answers a real prompt AFTER
 * the timeout already reported 'no-prompt'. Without it, a slow-but-genuine
 * grant would be thrown away and the user would have to click again.
 */
export async function requestMidiAccess(
  opts: {
    timeoutMs?: number;
    onLateResolve?: (access: MIDIAccessLike) => void;
  } = {},
): Promise<MidiAccessOutcome> {
  if (!webMidiSupported()) return { kind: 'unsupported' };
  const nav = navigator as unknown as NavigatorWithMidi;
  const budget = opts.timeoutMs ?? MIDI_PROMPT_TIMEOUT_MS;

  let settled = false;
  const request = nav
    .requestMIDIAccess!({ sysex: false })
    .then(
      (access): MidiAccessOutcome => {
        if (settled) {
          // The timeout already reported 'no-prompt' and the caller moved on —
          // hand the late grant over rather than dropping it on the floor.
          opts.onLateResolve?.(access);
          return { kind: 'granted', access };
        }
        settled = true;
        return { kind: 'granted', access };
      },
      (err: unknown): MidiAccessOutcome => {
        settled = true;
        const e = err as { name?: string; message?: string };
        return { kind: 'denied', message: e?.message || e?.name || 'Permission denied' };
      },
    );

  const timeout = new Promise<MidiAccessOutcome>((resolve) => {
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'no-prompt' });
    }, budget);
  });

  return Promise.race([request, timeout]);
}

/** What `queryMidiPermission` can report. 'unknown' = the Permissions API is
 *  absent or refuses the 'midi' name (Firefox) — treat it as NOT granted. */
export type MidiPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * Read the CURRENT Web MIDI permission state WITHOUT asking for access.
 *
 * This is the silent sibling of `requestMidiAccess` above: it can never cause
 * a prompt, so it is safe to call with no user gesture. Chromium persists a
 * midi(+sysex) grant per origin, so 'granted' here means a later
 * `requestMIDIAccess` resolves silently — which is exactly the check the
 * Electra auto-reconnect (#2248) needs on page load. Anything other than a
 * confirmed 'granted' (including a throwing / absent Permissions API) reports
 * conservatively, so callers stay quiet rather than risk an ungestured prompt.
 */
export async function queryMidiPermission(
  opts: { sysex?: boolean } = {},
): Promise<MidiPermissionState> {
  if (typeof navigator === 'undefined') return 'unknown';
  const perms = (navigator as unknown as {
    permissions?: { query?: (desc: unknown) => Promise<{ state?: string }> };
  }).permissions;
  if (!perms || typeof perms.query !== 'function') return 'unknown';
  try {
    const status = await perms.query({ name: 'midi', sysex: opts.sysex === true });
    const state = status?.state;
    return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown';
  } catch {
    return 'unknown'; // e.g. Firefox: TypeError on the 'midi' permission name
  }
}

/** User-facing explanation for a non-granted outcome. Written to be ACTIONABLE
 *  — the failing case that prompted all this was a user staring at a button
 *  with nothing to do next. */
export function midiOutcomeMessage(outcome: MidiAccessOutcome): string {
  switch (outcome.kind) {
    case 'granted':
      return '';
    case 'unsupported':
      return 'This browser has no Web MIDI support. Chrome, Edge or Opera are required.';
    case 'denied':
      return `MIDI access was refused (${outcome.message}). Allow MIDI for this site via the padlock in the address bar, then click again.`;
    case 'no-prompt':
      return 'No MIDI permission prompt appeared. Your browser may have quietly suppressed it on a new site — check the address bar for a permission icon, or allow MIDI for this site in browser settings, then click again.';
  }
}
