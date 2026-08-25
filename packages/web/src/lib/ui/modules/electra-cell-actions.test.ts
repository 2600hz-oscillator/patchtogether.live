// packages/web/src/lib/ui/modules/electra-cell-actions.test.ts
//
// THE SEND-TO-ELECTRA CELL'S AUDITION PROBE, AND ITS PERMANENT NEGATIVE CONTROL.
//
// `electra-connect-button-{n}` declares
// `probe: { effect: { kind: 'audition', seam: 'engine-message' } }`, and
// faces-parity presses it on CI. That press proves something only if
// `delivered: false` is REACHABLE — otherwise the probe degenerates into "this
// function was called", which is the vacuity the whole ledger exists to prevent.
// "The CI runner has no Electra One" is NOT a way to reach it: the Web MIDI
// capability is present on the runner, only the hardware is not.
//
// So the seam is INJECTED, and the no-capability leg below is the permanent
// negative control — it exercises the same branch a browser without Web MIDI
// takes, in the unit lane, with no browser and no device.
//
// ⚠ THE OTHER HALF THIS FILE OWES is the CROSSTALK GUARD. `auto?.stop()` before
// every run is not hygiene: its inbound listeners and feedback pump hold the OLD
// allocation table, and leaving them live makes ONE HARDWARE TWIST WRITE TWO
// PARAMS (the row-2↔row-3 ElectraControl crosstalk). That guard used to live in
// a component's click handler and now lives in the seam, so the leg proving it
// still fires — and fires BEFORE the run — moves here with it.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  auditionLog,
  __resetAuditionLedger,
  type AuditionRecord,
} from './audition-ledger';
import {
  electraSendToDevice,
  electraFlashOutcome,
  onElectraFlash,
  __resetElectraFlash,
  type ElectraFlashSeam,
} from './electra-cell-actions';

/** A seam whose every branch is observable and none of which touches a device. */
function makeSeam(over: Partial<ElectraFlashSeam> & { calls?: string[] } = {}): ElectraFlashSeam {
  const calls = over.calls ?? [];
  return {
    midiAvailable: () => true,
    stopPrevious: () => { calls.push('stop'); },
    run: async () => { calls.push('run'); return { ok: true, isElectra: true }; },
    publishBindings: () => { calls.push('publish'); },
    ...over,
  };
}

function records(): readonly AuditionRecord[] {
  return auditionLog();
}

/** Let the seam's promise chain settle. */
const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });

describe('electraControl SEND cell — the audition probe', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetElectraFlash();
  });

  it('records delivered=true when Web MIDI is there to be reached', async () => {
    const reached = electraSendToDevice('n1', makeSeam());
    expect(reached, 'the press reached the seam').toBe(true);
    expect(records().map((r) => ({ nodeId: r.nodeId, seam: r.seam, delivered: r.delivered }))).toEqual([
      { nodeId: 'n1', seam: 'engine-message', delivered: true },
    ]);
  });

  // ⚠ THE PERMANENT NEGATIVE CONTROL. Without this leg the probe above proves
  // only that a function ran. This is the autoconfig's own first branch
  // (`broker.connect()` → `{ ok: false, reason: 'no-midi-access' }`) — the one
  // condition under which the button is genuinely wired to nothing.
  it('records delivered=FALSE on a browser with no Web MIDI, and does not run', async () => {
    const calls: string[] = [];
    const reached = electraSendToDevice('n1', makeSeam({ calls, midiAvailable: () => false }));
    expect(reached, 'the press reached nothing').toBe(false);
    expect(calls, 'nothing downstream was touched').toEqual([]);
    expect(records().map((r) => ({ delivered: r.delivered, seam: r.seam }))).toEqual([
      { delivered: false, seam: 'engine-message' },
    ]);
    expect(electraFlashOutcome().status).toBe('no-device');
  });

  // ⚠ THE RECORD IS SYNCHRONOUS, BEFORE THE AWAIT. `run()` sits on
  // `requestMIDIAccess`, which can hang for as long as the browser feels like
  // when it declines to show its own prompt. If the record waited for the
  // OUTCOME, a probe would time out on the very path it most needs to observe.
  it('writes the record BEFORE the async run resolves', () => {
    let resolveRun!: (v: { ok: boolean; isElectra: boolean }) => void;
    electraSendToDevice(
      'n1',
      makeSeam({ run: () => new Promise((res) => { resolveRun = res; }) }),
    );
    // Nothing has resolved yet, and the ledger already has the record.
    expect(records()).toHaveLength(1);
    expect(records()[0]!.delivered).toBe(true);
    resolveRun({ ok: true, isElectra: true });
  });
});

describe('electraControl SEND cell — the crosstalk guard', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetElectraFlash();
  });

  // ⚠ ORDER IS THE ASSERTION, not merely presence. Stopping AFTER the new run
  // started would tear down the orchestrator that was just built.
  it('stops the previous orchestrator BEFORE starting a new run', async () => {
    const calls: string[] = [];
    electraSendToDevice('n1', makeSeam({ calls }));
    await flush();
    expect(calls).toEqual(['stop', 'run', 'publish']);
  });

  it('a second Send after the first completes stops the previous run again', async () => {
    const calls: string[] = [];
    const seam = makeSeam({ calls });
    electraSendToDevice('n1', seam);
    await flush();
    electraSendToDevice('n1', seam);
    await flush();
    expect(calls).toEqual(['stop', 'run', 'publish', 'stop', 'run', 'publish']);
  });

  // The button's own re-entrancy guard, preserved: a press while a flash is in
  // flight is dropped rather than starting a second orchestrator.
  it('a press while CONNECTING is refused and records nothing', () => {
    const calls: string[] = [];
    electraSendToDevice('n1', makeSeam({ calls, run: () => new Promise(() => {}) }));
    expect(electraFlashOutcome().status).toBe('connecting');
    const second = electraSendToDevice('n1', makeSeam({ calls }));
    expect(second).toBe(false);
    expect(records(), 'the refused press is not an audition').toHaveLength(1);
  });
});

describe('electraControl SEND cell — the outcome the button used to discard', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetElectraFlash();
  });

  // ⚠ THIS IS A FIXED DEFECT, NOT A NEW FEATURE. The button computed `detail` on
  // four paths and rendered it on NONE, so a failed flash discarded its own
  // reason — including a thrown error's message. It now reaches `aria-label`:
  // speakable and assertable, and never painted.
  it('a failed run keeps its reason', async () => {
    electraSendToDevice('n1', makeSeam({ run: async () => ({ ok: false, isElectra: false, reason: 'upload-rejected' }) }));
    await flush();
    expect(electraFlashOutcome()).toEqual({ status: 'error', detail: 'upload-rejected' });
  });

  it('a THROWN error keeps its message instead of becoming an unhandled rejection', async () => {
    electraSendToDevice('n1', makeSeam({ run: async () => { throw new Error('sysex blocked'); } }));
    await flush();
    expect(electraFlashOutcome()).toEqual({ status: 'error', detail: 'sysex blocked' });
  });

  // ⚠ THE BRANCH THAT WAS DEAD. `status = res.isElectra ? 'ready' : 'ready'` —
  // both arms identical — and the only other reader of `isElectra` was a string
  // nothing rendered, so the flag had NO observable effect anywhere in the UI.
  // Both arms are still `ready` (the upload genuinely happens either way); what
  // differs is now observable.
  it('a CONFIRMED and an UNCONFIRMED device are both ready and no longer indistinguishable', async () => {
    electraSendToDevice('n1', makeSeam({ run: async () => ({ ok: true, isElectra: true }) }));
    await flush();
    const confirmed = electraFlashOutcome();

    __resetElectraFlash();
    electraSendToDevice('n1', makeSeam({ run: async () => ({ ok: true, isElectra: false }) }));
    await flush();
    const unconfirmed = electraFlashOutcome();

    expect(confirmed.status).toBe('ready');
    expect(unconfirmed.status).toBe('ready');
    expect(confirmed.detail, 'the flag now reaches an observable').not.toEqual(unconfirmed.detail);
  });

  it('publishes the display badges only on a SUCCESSFUL run', async () => {
    const calls: string[] = [];
    // ⚠ The override REPLACES the default `run`, so `calls` records only 'stop'
    // and (on success) 'publish'. The invariant under test is the ABSENCE of
    // 'publish', asserted directly rather than through a full call list that
    // would drift with the fixture.
    electraSendToDevice('n1', makeSeam({ calls, run: async () => ({ ok: false, isElectra: false, reason: 'no-midi-access' }) }));
    await flush();
    expect(calls, 'a failed flash must not claim bound badges').not.toContain('publish');
    expect(electraFlashOutcome().status).toBe('no-device');

    // The POSITIVE half, so the assertion above cannot pass by never publishing
    // at all — which is the shape that would make this leg decoration.
    __resetElectraFlash();
    const ok: string[] = [];
    electraSendToDevice('n1', makeSeam({ calls: ok }));
    await flush();
    expect(ok, 'a successful flash DOES claim them').toContain('publish');
  });
});

describe('electraControl SEND cell — the outcome store', () => {
  beforeEach(() => {
    __resetAuditionLedger();
    __resetElectraFlash();
  });

  // The store exists because a ranked cell is rendered by the SHARED shell and
  // the surface that shows the outcome is a different component again. A
  // subscriber that cannot be released is the node-resource-leak class.
  it('notifies subscribers and releases them on unsubscribe', async () => {
    let seen = 0;
    const off = onElectraFlash(() => { seen += 1; });
    electraSendToDevice('n1', makeSeam());
    await flush();
    expect(seen, 'connecting + ready').toBeGreaterThan(0);
    const afterSubscribed = seen;
    off();
    __resetElectraFlash();
    electraSendToDevice('n2', makeSeam());
    await flush();
    expect(seen, 'no notifications after unsubscribe').toBe(afterSubscribed);
  });
});
