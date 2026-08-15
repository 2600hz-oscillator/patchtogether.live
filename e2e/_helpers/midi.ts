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
 *
 *  ⚠ The count is per INPUT PORT, not per subscriber, and this mock exposes
 *  exactly ONE input — so `minHandlers` can never exceed 1 and a caller passing
 *  2 would wait forever. (`onmidimessage` is a single slot: two subsystems on
 *  one port do not make two handlers, the second replaces the first.) The old
 *  doc here advertised "pass 2 for midi-learn AND midi-clock-source"; nothing
 *  ever did, and it could not have worked. Add a second mock input first if a
 *  spec genuinely needs two live ports. */
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

// ---------------------------------------------------------------------------
// OUTBOUND capture — the bytes-on-the-wire instrument
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS SEPARATELY FROM `installMidiMock` ABOVE. That mock's output
// port has a deliberately NO-OP `send()` ("outbound MIDI not asserted by
// current specs"), because its job is to feed the app INbound messages. An
// outbound assertion needs the opposite: a port that records every byte.
//
// This helper is the EXTRACTED form of a script that had already been
// copy-pasted twice verbatim (`midi-out-buddy.spec.ts`, and
// `workflow-channel-columns.spec.ts` whose own comment says "Mirrors the fake
// in midi-out-buddy.spec.ts"). A third copy was about to be written for the
// device-control work, so it is a helper now.
//
// ⚠ THIS IS THE ONLY INSTRUMENT THAT CAN SEE THE SUBJECT. Every def-reading
// gate in the repo — contract-lock, module-docs-lint, the range assertions,
// the per-port sweeps — is structurally blind to what actually leaves a MIDI
// port. A module can declare a perfect CC contract, render a perfect card, and
// emit nothing at all, and the entire rest of the gate set stays green. So the
// bytes captured here are load-bearing in a way a visibility assertion is not,
// and the instrument itself is negative-controlled before it is trusted (see
// `midi-out-capture-instrument` in midi-out-buddy.spec.ts).
//
// Two views of the same recording:
//   * `window.__midiOutSent`         — flat `number[][]`, every port merged.
//     The shape the two pre-existing specs already assert against; unchanged.
//   * `window.__midiOutSentDetailed` — `{ portId, bytes, at }[]`, so a spec
//     with more than one output port can tell them apart, and so a spec can
//     assert ORDER and TIMING rather than just membership.

/** One captured outbound MIDI message. */
export interface CapturedMidiMessage {
  /** The `MIDIOutput.id` the message was written to. */
  portId: string;
  /** The raw bytes, as a plain array (structured-clone safe across the CDP seam). */
  bytes: number[];
  /** `performance.now()` at capture — NOT the `send()` timestamp argument. */
  at: number;
  /** The `timestamp` argument passed to `send(bytes, timestamp)`, when the
   *  caller scheduled the message rather than sending it immediately.
   *  `undefined` for an immediate send. This is what proves a module is using
   *  Web MIDI's own scheduling instead of a main-thread setTimeout. */
  scheduledAt: number | undefined;
}

/** A fake output port to expose on the mocked MIDIAccess. */
export interface FakeMidiOutPort {
  id: string;
  name: string;
}

/** The default single port — the exact id + name the two pre-existing specs
 *  hardcoded, so migrating them to this helper is a no-op on the wire. */
export const DEFAULT_FAKE_MIDI_OUT: FakeMidiOutPort = {
  id: 'fake-midi-out-0',
  name: 'Fake MIDI Out (Playwright)',
};

/** Build the page-context init script for a capturing Web MIDI mock. */
export function midiOutCaptureScript(ports: readonly FakeMidiOutPort[]): string {
  return `
(() => {
  if (window.__fakeMidiOutInstalled) return;
  window.__fakeMidiOutInstalled = true;
  window.__midiOutSent = [];          // number[][] — flat, all ports merged
  window.__midiOutSentDetailed = [];  // { portId, bytes, at, scheduledAt }[]

  const specs = ${JSON.stringify(ports)};
  const outputs = new Map();
  for (const spec of specs) {
    const output = {
      id: spec.id,
      name: spec.name,
      manufacturer: 'PatchTogether',
      state: 'connected',
      connection: 'open',
      type: 'output',
      version: '1.0',
      send(data, timestamp) {
        const bytes = Array.from(data);
        window.__midiOutSent.push(bytes);
        window.__midiOutSentDetailed.push({
          portId: spec.id,
          bytes,
          at: performance.now(),
          scheduledAt: typeof timestamp === 'number' ? timestamp : undefined,
        });
      },
      clear() {},
    };
    outputs.set(spec.id, output);
  }

  const access = {
    sysexEnabled: false,
    inputs: new Map(),
    outputs,
    onstatechange: null,
  };
  navigator.requestMIDIAccess = async () => access;
})();
`;
}

/**
 * Install the capturing MIDI-out mock. MUST be called BEFORE `page.goto(...)`
 * so the app's first `navigator.requestMIDIAccess()` resolves against it.
 *
 * Pass `ports` to expose more than one output, or to give a port a name a
 * device auto-detect heuristic will match.
 */
export async function installMidiOutCapture(
  page: Page,
  ports: readonly FakeMidiOutPort[] = [DEFAULT_FAKE_MIDI_OUT],
): Promise<void> {
  await page.addInitScript({ content: midiOutCaptureScript(ports) });
}

/** Read every captured message, newest last. `portId` filters to one port. */
export async function readMidiOutCaptured(
  page: Page,
  portId?: string,
): Promise<CapturedMidiMessage[]> {
  return page.evaluate((wanted) => {
    const w = window as unknown as { __midiOutSentDetailed?: CapturedMidiMessage[] };
    const all = w.__midiOutSentDetailed ?? [];
    return wanted ? all.filter((m) => m.portId === wanted) : all;
  }, portId);
}

/** Drop everything captured so far. Use between phases of a test so a later
 *  assertion counts only the messages its own action produced. */
export async function clearMidiOutCaptured(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __midiOutSent?: number[][];
      __midiOutSentDetailed?: unknown[];
    };
    if (w.__midiOutSent) w.__midiOutSent.length = 0;
    if (w.__midiOutSentDetailed) w.__midiOutSentDetailed.length = 0;
  });
}

/** Every captured CONTROL CHANGE, decoded. `0xB0..0xBF` status. */
export async function readCapturedCcs(
  page: Page,
  portId?: string,
): Promise<{ channel: number; cc: number; value: number }[]> {
  const msgs = await readMidiOutCaptured(page, portId);
  return msgs
    .filter((m) => (m.bytes[0] ?? 0) >= 0xb0 && (m.bytes[0] ?? 0) <= 0xbf)
    .map((m) => ({
      // Report the 1-based on-wire channel, the convention the rest of this
      // helper module uses (see sendCc above). Stating it here rather than
      // leaving a bare nibble is what stops the classic off-by-one read.
      channel: ((m.bytes[0] ?? 0) & 0x0f) + 1,
      cc: m.bytes[1] ?? 0,
      value: m.bytes[2] ?? 0,
    }));
}

/** Burst N clock pulses spaced `intervalMs` apart. Returns the ACTUAL
 *  `performance.now()` timestamp (ms) of each pulse, recorded in-page
 *  immediately before the synchronous dispatch — so within microseconds of
 *  the `deps.now()` the clock source stamps on arrival.
 *
 *  Math: midi-clock-source.ts smoothes the per-pulse interval, then computes
 *      quarterMs = pulsePeriodMs * 24
 *      bpm      = 60000 / quarterMs = 2500 / pulsePeriodMs
 *  So intervalMs = 25 → 100 BPM, intervalMs = 50 → 50 BPM, etc.
 *
 *  ⚠ `intervalMs` is a setTimeout REQUEST, not a delivery guarantee — on a
 *  loaded runner the real spacing runs long (measured 57–58 ms for a 50 ms
 *  request on CI, i.e. ~43 BPM where 50 was "sent"). A caller asserting on
 *  the derived tempo must therefore derive its EXPECTATION from the returned
 *  timestamps (same clock as the subject), never from `intervalMs`. */
export async function sendClockBurst(
  page: Page,
  count: number,
  intervalMs: number,
): Promise<number[]> {
  return await page.evaluate(
    ({ count, intervalMs }) => {
      const w = window as unknown as { __mockMidi: { clock(): void } };
      return new Promise<number[]>((resolve) => {
        const sentAtMs: number[] = [];
        let i = 0;
        function tick() {
          if (i >= count) { resolve(sentAtMs); return; }
          // Record BEFORE the dispatch: __mockMidi.clock() invokes the app's
          // onmidimessage handler synchronously, which stamps deps.now().
          sentAtMs.push(performance.now());
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

/** Replay midi-clock-source.ts's EXACT derivation (one-pole α=0.25 over the
 *  inter-pulse intervals, 24 ppqn, 10–300 BPM validity clamp) over a burst's
 *  actual send timestamps. This is the same-clock EXPECTATION for what
 *  `getBpm()` must return after that burst — renderer- and load-independent
 *  by construction, because both sides observe the identical arrival times. */
export function replayDerivedBpm(sentAtMs: number[]): number | null {
  const MIDI_PPQN = 24;
  const MIN_BPM = 10;
  const MAX_BPM = 300;
  let pulsePeriodMs: number | null = null;
  let bpm: number | null = null;
  for (let i = 1; i < sentAtMs.length; i++) {
    const dt = sentAtMs[i]! - sentAtMs[i - 1]!;
    if (dt > 0) {
      pulsePeriodMs = pulsePeriodMs === null ? dt : pulsePeriodMs + (dt - pulsePeriodMs) * 0.25;
      const derived = 60000 / (pulsePeriodMs * MIDI_PPQN);
      if (derived >= MIN_BPM && derived <= MAX_BPM) bpm = derived;
    }
  }
  return bpm;
}
