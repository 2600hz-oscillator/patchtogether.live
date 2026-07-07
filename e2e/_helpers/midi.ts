// e2e/_helpers/midi.ts
//
// MIDI mock for Playwright. Replaces `navigator.requestMIDIAccess` with an
// in-page fake before the app's first call, so the real midi-learn singleton
// and the real midi-clock-source both see our mock input and wire their
// `onmidimessage` handlers to it.
//
// Why a custom mock (not the existing DEV `__midiTestInject` hook):
//   * `__midiTestInject` only patches `midi-learn.svelte.ts`'s singleton (it
//     calls `installSimulatedMidiDevice` which assigns the singleton's `access`
//     directly). It does NOT cover `midi-clock-source.ts`, which holds its OWN
//     `access` and wires its OWN `onmidimessage` via `navigator.requestMIDIAccess`.
//   * `__midiTestInject` is stripped in prod builds (`import.meta.env.DEV`
//     gate in Canvas.svelte). The mock here works in prod too, so this same
//     harness can be re-used against `vite preview` if we ever route a smoke
//     subset through it.
//   * Going through `navigator.requestMIDIAccess` exercises the actual
//     subscription path (iterate `access.inputs.values()` + set
//     `inp.onmidimessage`) — so any future refactor that breaks the real
//     subscription pattern surfaces in this harness, not just at hardware
//     plug-in.
//
// Subscription pattern the app uses (READ THE SOURCE — both subscribers do
// this; the mock must match):
//
//   const access = await navigator.requestMIDIAccess({ sysex: false });
//   for (const inp of access.inputs.values()) {
//     inp.onmidimessage = (ev) => handle(ev.data /* Uint8Array */);
//   }
//
// `onmidimessage` is a SETTABLE PROPERTY, not an `addEventListener('midimessage')`
// target. The mock's `MockMIDIInput` therefore exposes `onmidimessage` as a
// getter/setter that stashes the handler so `__mockMidi.send([...])` can
// invoke it directly.

import type { Page } from '@playwright/test';

/**
 * Page-context init script (runs BEFORE the app boots so the very first
 * `navigator.requestMIDIAccess()` call sees the mock). Add via
 * `installMidiMock(page)` before any `page.goto(...)`.
 */
export const installMidiMockScript = `
(() => {
  if (window.__mockMidiInstalled) return;
  window.__mockMidiInstalled = true;

  // Per-input handler stash. The app sets \`inp.onmidimessage = fn\` (a
  // property, not addEventListener), and we invoke the stashed fn from
  // __mockMidi.send / .cc / .noteOn / etc.
  const inputHandlers = new Map(); // inputId -> ((ev: { data, timeStamp }) => void) | null

  function makeInput(id, name) {
    let _handler = null;
    const input = {
      id,
      name,
      manufacturer: 'PatchTogether',
      state: 'connected',
      connection: 'open',
      type: 'input',
      version: '1.0',
      get onmidimessage() { return _handler; },
      set onmidimessage(fn) {
        _handler = fn;
        inputHandlers.set(id, fn);
      },
    };
    inputHandlers.set(id, null);
    return input;
  }

  function makeOutput(id, name) {
    return {
      id,
      name,
      manufacturer: 'PatchTogether',
      state: 'connected',
      connection: 'open',
      type: 'output',
      version: '1.0',
      send() { /* noop — outbound MIDI not asserted by current specs */ },
      clear() {},
    };
  }

  const input = makeInput('mock-midi-in-0', 'Mock MIDI Input');
  const output = makeOutput('mock-midi-out-0', 'Mock MIDI Output');

  const inputs = new Map([[input.id, input]]);
  const outputs = new Map([[output.id, output]]);

  const access = {
    sysexEnabled: false,
    inputs,
    outputs,
    onstatechange: null,
  };

  // Track how many times requestMIDIAccess is called so tests can assert the
  // on-demand contract (e.g. spawning a default-System COFEFVE must NOT
  // request access; only an explicit MIDI action / tempo read does).
  let accessCalls = 0;
  // eslint-disable-next-line no-unused-vars
  navigator.requestMIDIAccess = async (_opts) => { accessCalls++; return access; };

  function dispatch(bytes) {
    const data = new Uint8Array(bytes);
    const ev = { data, timeStamp: performance.now() };
    // Invoke every wired input. Today there is one; if a future test wires
    // multiple, all will fire — matching how real multi-port hardware behaves.
    for (const h of inputHandlers.values()) {
      if (typeof h === 'function') h(ev);
    }
  }

  window.__mockMidi = {
    /** Raw byte array, e.g. [0xB0, 20, 64]. */
    send(bytes) { dispatch(bytes); },
    /** Control Change. channel is 1..16 (the on-wire MIDI convention);
     *  we convert to the 0..15 low-nibble the spec demands. */
    cc(channel, controller, value) {
      const status = 0xB0 | ((channel - 1) & 0x0F);
      dispatch([status, controller & 0x7F, value & 0x7F]);
    },
    noteOn(channel, note, velocity) {
      const status = 0x90 | ((channel - 1) & 0x0F);
      dispatch([status, note & 0x7F, velocity & 0x7F]);
    },
    noteOff(channel, note, velocity) {
      const status = 0x80 | ((channel - 1) & 0x0F);
      dispatch([status, note & 0x7F, (velocity ?? 0) & 0x7F]);
    },
    /** System Real-Time Clock pulse (24 ppqn). */
    clock() { dispatch([0xF8]); },
    /** System Real-Time Start. */
    start() { dispatch([0xFA]); },
    /** System Real-Time Stop. */
    stop() { dispatch([0xFC]); },
    /** Inspection helper — how many inputs have a live handler attached.
     *  Used by tests to wait until the app has subscribed before sending. */
    handlerCount() {
      let n = 0;
      for (const h of inputHandlers.values()) if (typeof h === 'function') n++;
      return n;
    },
    /** How many times the app has called navigator.requestMIDIAccess. The
     *  on-demand-prompt regression asserts this stays 0 until a real MIDI
     *  action (tempo read / MIDI-clock select / MIDI Learn / MIDI module). */
    accessCallCount() { return accessCalls; },
  };
})();
`;

/**
 * Install the MIDI mock as an init script. MUST be called BEFORE
 * `page.goto(...)` so the app's very first `navigator.requestMIDIAccess()`
 * resolves against the mock.
 */
export async function installMidiMock(page: Page): Promise<void> {
  await page.addInitScript({ content: installMidiMockScript });
}

/** Wait until at least one mock-input has had its `onmidimessage` handler
 *  attached by the app. Returns once the count is >= `minHandlers`.
 *  Default minimum is 1 — sufficient for midi-learn alone. For specs that
 *  exercise both midi-learn AND midi-clock-source, pass 2. */
export async function waitForMidiSubscription(page: Page, minHandlers = 1): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const w = window as unknown as { __mockMidi?: { handlerCount(): number } };
      return !!w.__mockMidi && w.__mockMidi.handlerCount() >= n;
    },
    minHandlers,
    { timeout: 10_000 },
  );
}

/** Send a CC. Channel is 1..16 (on-wire convention); the binding the app
 *  stores will use channel-1 (the 4-bit nibble). */
export async function sendCc(page: Page, channel: number, cc: number, value: number): Promise<void> {
  await page.evaluate(
    ({ ch, cc, v }) => {
      const w = window as unknown as { __mockMidi: { cc(c: number, cc: number, v: number): void } };
      w.__mockMidi.cc(ch, cc, v);
    },
    { ch: channel, cc, v: value },
  );
}

// (sendNoteOn / sendNoteOff were pruned as unreferenced exports — LoC
// campaign row 16. The __mockMidi init-script still exposes noteOn/noteOff;
// re-add thin wrappers if a spec needs them.)

/** Burst N clock pulses spaced `intervalMs` apart.
 *
 *  Math: midi-clock-source.ts smoothes the per-pulse interval, then computes
 *      quarterMs = pulsePeriodMs * 24
 *      bpm      = 60000 / quarterMs = 2500 / pulsePeriodMs
 *  So intervalMs = 25 → 100 BPM, intervalMs = 50 → 50 BPM, etc.
 *
 *  The source uses one-pole smoothing with α=0.25, so several pulses are
 *  needed for the derived BPM to settle. ~24 pulses (one quarter note) is
 *  enough; tests should send more to be robust against timer jitter. */
export async function sendClockBurst(
  page: Page,
  count: number,
  intervalMs: number,
): Promise<void> {
  await page.evaluate(
    ({ count, intervalMs }) => {
      const w = window as unknown as { __mockMidi: { clock(): void } };
      return new Promise<void>((resolve) => {
        let i = 0;
        function tick() {
          if (i >= count) { resolve(); return; }
          w.__mockMidi.clock();
          i++;
          setTimeout(tick, intervalMs);
        }
        tick();
      });
    },
    { count, intervalMs },
  );
}
