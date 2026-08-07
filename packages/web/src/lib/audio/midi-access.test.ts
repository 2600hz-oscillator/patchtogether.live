// A SUPPRESSED PROMPT AND A BROKEN BUTTON MUST NOT LOOK THE SAME.
//
// Owner-reported 2026-08-07: on a fresh origin both "Connect MIDI…" buttons
// were dead — no prompt, no console error, no state change. Nothing in the app
// was wrong; Chromium had quietly declined to show the permission prompt, and
// `requestMIDIAccess` simply never settled. The old code had no branch for
// that, so the UI said nothing at all.
//
// The whole point of this module is that EVERY outcome is nameable, so these
// tests are about the taxonomy, not about MIDI.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestMidiAccess,
  midiOutcomeMessage,
  webMidiSupported,
  type MIDIAccessLike,
} from './midi-access';

const nav = () => globalThis.navigator as unknown as Record<string, unknown>;
let original: unknown;

function fakeAccess(): MIDIAccessLike {
  return { inputs: new Map(), outputs: new Map(), onstatechange: null };
}

beforeEach(() => {
  if (typeof globalThis.navigator === 'undefined') {
    (globalThis as Record<string, unknown>).navigator = {};
  }
  original = nav().requestMIDIAccess;
});
afterEach(() => {
  if (original === undefined) delete nav().requestMIDIAccess;
  else nav().requestMIDIAccess = original;
  vi.useRealTimers();
});

describe('requestMidiAccess — every outcome is nameable', () => {
  it('THE REGRESSION: a prompt that never settles reports no-prompt, not silence', async () => {
    // Exactly the reported failure: the browser suppresses the prompt, so the
    // promise hangs forever. Before this module the caller awaited it and the
    // UI sat unchanged — indistinguishable from a broken button.
    nav().requestMIDIAccess = () => new Promise(() => {}); // never settles
    const outcome = await requestMidiAccess({ timeoutMs: 20 });
    expect(outcome.kind).toBe('no-prompt');
    expect(midiOutcomeMessage(outcome)).toMatch(/did not|No MIDI permission prompt/i);
    // The message must tell the user what to DO — the failing case was a user
    // with nothing to try next.
    expect(midiOutcomeMessage(outcome)).toMatch(/address bar|settings/i);
  });

  it('a LATE answer to a real prompt is still honoured, not thrown away', async () => {
    // The timeout is a heuristic; a slow-but-genuine grant must not be lost, or
    // the fix would introduce a worse bug than the one it cures.
    let resolveIt: (a: MIDIAccessLike) => void = () => {};
    nav().requestMIDIAccess = () => new Promise<MIDIAccessLike>((r) => { resolveIt = r; });
    const late: MIDIAccessLike[] = [];
    const outcome = await requestMidiAccess({ timeoutMs: 20, onLateResolve: (a) => late.push(a) });
    expect(outcome.kind).toBe('no-prompt');
    const granted = fakeAccess();
    resolveIt(granted);
    await new Promise((r) => setTimeout(r, 5));
    expect(late, 'the late grant reached the caller').toEqual([granted]);
  });

  it('a rejection reports denied WITH the browser reason', async () => {
    nav().requestMIDIAccess = () =>
      Promise.reject(Object.assign(new Error('Permission to use Web MIDI API was not granted.'), {
        name: 'NotAllowedError',
      }));
    const outcome = await requestMidiAccess({ timeoutMs: 500 });
    expect(outcome.kind).toBe('denied');
    expect(midiOutcomeMessage(outcome)).toContain('not granted');
    expect(midiOutcomeMessage(outcome)).toMatch(/padlock|address bar/i);
  });

  it('a grant returns the access', async () => {
    const a = fakeAccess();
    nav().requestMIDIAccess = () => Promise.resolve(a);
    const outcome = await requestMidiAccess({ timeoutMs: 500 });
    expect(outcome.kind).toBe('granted');
    expect(outcome.kind === 'granted' && outcome.access).toBe(a);
    expect(midiOutcomeMessage(outcome)).toBe('');
  });

  it('no Web MIDI at all reports unsupported, and never calls anything', async () => {
    delete nav().requestMIDIAccess;
    expect(webMidiSupported()).toBe(false);
    const outcome = await requestMidiAccess({ timeoutMs: 500 });
    expect(outcome.kind).toBe('unsupported');
    expect(midiOutcomeMessage(outcome)).toMatch(/Web MIDI/i);
  });

  it('NEGATIVE CONTROL — a fast grant does NOT report no-prompt', async () => {
    // Guards the instrument in the other direction: a timeout that fired too
    // eagerly would label every healthy grant as a suppressed prompt, which is
    // a worse lie than saying nothing.
    nav().requestMIDIAccess = () =>
      new Promise<MIDIAccessLike>((r) => setTimeout(() => r(fakeAccess()), 5));
    const outcome = await requestMidiAccess({ timeoutMs: 200 });
    expect(outcome.kind).toBe('granted');
  });

  it('every outcome kind has a non-empty, distinct message except granted', () => {
    // A taxonomy is only useful if the UI can tell the cases apart.
    const msgs = [
      midiOutcomeMessage({ kind: 'unsupported' }),
      midiOutcomeMessage({ kind: 'denied', message: 'x' }),
      midiOutcomeMessage({ kind: 'no-prompt' }),
    ];
    for (const m of msgs) expect(m.length).toBeGreaterThan(20);
    expect(new Set(msgs).size, 'the three failure messages are distinguishable').toBe(3);
  });
});
