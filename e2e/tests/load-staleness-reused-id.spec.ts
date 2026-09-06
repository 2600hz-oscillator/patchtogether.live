// e2e/tests/load-staleness-reused-id.spec.ts
//
// THE HYDRATE-ONCE FAMILY, END TO END — fleet audit 2026-09-06, findings #4
// (midi-cv-buddy, midi-lane, midi-out-buddy, midiclock) and #8 (audio-out).
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────
// A module factory reads its discrete settings off `node.data` once. The
// reconciler re-materializes a node ONLY on id-absence or a type/domain
// change and never diffs `data`; `loadEnvelopeIntoStore` deletes and
// re-inserts every node at its SAME id in one transaction. So a SAME-SESSION
// load (open a patch over a running rack) keeps every engine handle exactly as
// it was — the previous patch's MIDI channel, port, division, output sink —
// while the doc and every surface show the loaded ones. Silence with every
// lamp green. The fix watches a projection of the LIVE node and re-applies
// through the setters the surfaces use (`$lib/audio/live-node-data`).
//
// ── WHAT EACH LEG PROVES, AND HOW IT IS DISCRIMINATING ──────────────────────
// Every leg drives the REAL default-mode source through the module to an
// OBSERVABLE OUTPUT: a mock Web MIDI port (the same `navigator.requestMIDIAccess`
// path hardware takes) or a self-running KRIA on the CV side, and on the far
// side a SCOPE reading the module's gate/run output, the bytes on a captured
// MIDI output port, or `setSinkId` being called on the live AudioContext.
// Nothing here asserts that data landed in the doc — that was always true.
//
// The envelope is an opaque Y.Doc update, so a v2 patch cannot be crafted by
// hand. Each leg therefore: (1) seeds v1, proves it live; (2) edits to v2 the
// way the FACE does — api call AND doc write, which lands on ANY build; (3)
// saves nothing new, but LOADS the v1 envelope over the running v2 rack at
// the same ids; (4) asserts v1's behaviour is back. A build without the fix
// stays on v2 after step 3 and fails step 4.

import { test, expect, type Page } from '@playwright/test';
import { seedKriaWith, buildKriaMidiData } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';
import { installMidiDeviceMock, injectMidiDeviceIn, clearMidiOutCaptured } from '../_helpers/midi';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

/** A held gate / RUN is a 1.0 constant on the scope; anything under this is
 *  "not driven". The floor is generous so a SwiftShader runner's analyser
 *  smoothing cannot turn a real 1.0 into a miss. */
const GATE_HIGH = 0.8;
const SILENT = 0.1;
/** The observation window for a NEGATIVE claim ("this port/channel no longer
 *  drives the output"). A cap on the failure, not a readiness wait. */
const DEAF_WINDOW_MS = 500;

const NOTE_ON = (ch0: number, note = 60): number[] => [0x90 | ch0, note, 100];
const NOTE_OFF = (ch0: number, note = 60): number[] => [0x80 | ch0, note, 0];

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
  );
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
  return errors;
}

interface SeedNode {
  id: string;
  type: string;
  params?: Record<string, number>;
  data?: Record<string, unknown>;
}
interface SeedEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType: string;
  targetType: string;
}

/** Build a patch INCLUDING `node.data` in ONE transaction — `spawnPatch`
 *  drops `data`, and the saved settings are the whole subject here. */
async function seedPatch(page: Page, nodes: SeedNode[], edges: SeedEdge[] = []): Promise<void> {
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const id of Object.keys(w.__patch.edges)) delete w.__patch.edges[id];
        for (const id of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[id];
        nodes.forEach((n, i) => {
          w.__patch.nodes[n.id] = {
            id: n.id,
            type: n.type,
            domain: 'audio',
            position: { x: 80 + i * 340, y: 80 },
            params: n.params ?? {},
            ...(n.data ? { data: n.data } : {}),
          };
        });
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceType: e.sourceType,
            targetType: e.targetType,
          };
        }
      });
    },
    { nodes, edges },
  );
  for (const n of nodes) {
    await expect(page.locator(`.svelte-flow__node[data-id="${n.id}"]`).first()).toBeVisible({
      timeout: BOOT_MS,
    });
  }
}

/** The engine handle exists (the reconciler has added the node), so a
 *  card-api call cannot be silently dropped. */
async function waitForHandle(page: Page, nodeId: string, key: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([id, k]) => {
            const w = globalThis as unknown as {
              __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
              __patch: { nodes: Record<string, unknown> };
            };
            const eng = w.__engine?.();
            const node = w.__patch.nodes[id];
            return !!(eng && node && eng.read(node, k) !== undefined);
          },
          [nodeId, key] as const,
        ),
      { message: `${nodeId}: the engine handle answers read('${key}')`, timeout: BOOT_MS },
    )
    .toBe(true);
}

/** CONNECT through the module's card-api (the seam every surface uses), and
 *  optionally pick a port — the mock grants instantly. */
async function connectMidi(page: Page, nodeId: string, deviceId?: string): Promise<void> {
  await waitForHandle(page, nodeId, 'card-api');
  const ok = await page.evaluate(
    async ([id, dev]) => {
      const w = globalThis as unknown as {
        __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const api = w.__engine!()!.read(w.__patch.nodes[id], 'card-api') as {
        connect: () => Promise<boolean>;
        selectDevice: (d: string | null) => void;
      };
      const granted = await api.connect();
      if (granted && dev) api.selectDevice(dev);
      return granted;
    },
    [nodeId, deviceId ?? ''] as const,
  );
  expect(ok, `${nodeId}: the mock grant connected`).toBe(true);
}

async function saveEnvelope(page: Page): Promise<unknown> {
  const env = await page.evaluate(() => {
    const w = window as unknown as { __persistence?: { save?: () => unknown } };
    return w.__persistence?.save?.();
  });
  expect(env, '__persistence.save() unavailable — DEV build expected').toBeTruthy();
  return env;
}

/** Apply an envelope OVER the running rack: the ids are reused, no node is
 *  re-materialized, and only the doc moves — the exact route under test. */
async function loadSameSession(page: Page, env: unknown, ids: readonly string[]): Promise<void> {
  await page.evaluate((e) => {
    const w = window as unknown as { __persistence: { load: (env: unknown) => unknown } };
    w.__persistence.load(e);
  }, env);
  for (const id of ids) {
    await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`).first()).toBeVisible({
      timeout: BOOT_MS,
    });
  }
}

/** Read a node's live data key, straight off the store. */
async function readData(page: Page, nodeId: string, key: string): Promise<unknown> {
  return page.evaluate(
    ([id, k]) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      return w.__patch.nodes[id]?.data?.[k];
    },
    [nodeId, key] as const,
  );
}

async function scopePeak(page: Page, ms: number): Promise<number> {
  return (await readScopePeakOverWindow(page, 'scp', ms)).peak;
}

/** Hold a note (re-injected each poll, because a note that lands BEFORE a
 *  re-hydrate is filtered and never held) until the scope reads the gate. */
async function holdUntilGateHigh(page: Page, port: string, bytes: number[], message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        expect(await injectMidiDeviceIn(page, port, bytes), `${port} has a live handler`).toBe(true);
        return scopePeak(page, 150);
      },
      { timeout: 10_000, message },
    )
    .toBeGreaterThan(GATE_HIGH);
}

async function expectSilent(page: Page, message: string): Promise<void> {
  await expect.poll(() => scopePeak(page, 150), { timeout: 10_000, message }).toBeLessThan(SILENT);
}

/** A NEGATIVE claim: over a whole window the output never rises. */
async function expectStaysSilent(page: Page, message: string): Promise<void> {
  expect(await scopePeak(page, DEAF_WINDOW_MS), message).toBeLessThan(SILENT);
}

function toScope(id: string, nodeId: string, portId: string, sourceType: 'gate' | 'cv'): SeedEdge {
  return { id, from: { nodeId, portId }, to: { nodeId: 'scp', portId: 'ch1' }, sourceType, targetType: 'audio' };
}

// ── #4a midi-cv-buddy — the channel filter ──────────────────────────────────

test('midi-cv-buddy: a same-session load restores the LOADED channel filter — the gate follows it', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
  await installMidiDeviceMock(page, { outputs: [], inputs: [{ id: 'keys-a', name: 'Keys A' }] });
  const errors = await boot(page);
  await seedPatch(
    page,
    [
      { id: 'mcb', type: 'midiCvBuddy', data: { midiInChannel: 0, lastDeviceId: 'keys-a', lastDeviceName: 'Keys A' } },
      { id: 'scp', type: 'scope' },
    ],
    [toScope('e-gate', 'mcb', 'gate', 'gate')],
  );
  await connectMidi(page, 'mcb');

  // v1 LIVE: channel 1 drives the gate. (The poll doubles as the instrument's
  // positive control — inject() is false until the handler is attached.)
  await holdUntilGateHigh(page, 'keys-a', NOTE_ON(0), 'v1: a channel-1 note raises the gate');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(0));
  await expectSilent(page, 'v1: note off drops the gate');
  const envV1 = await saveEnvelope(page);

  // The FACE's edit path to v2 (channel 5): api + doc. Lands on any build.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { read: (n: unknown, k: string) => unknown };
      __patch: { nodes: Record<string, { data: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    (w.__engine().read(w.__patch.nodes['mcb'], 'card-api') as { setChannel: (c: number) => void }).setChannel(4);
    w.__ydoc.transact(() => { w.__patch.nodes['mcb']!.data.midiInChannel = 4; });
  });
  await injectMidiDeviceIn(page, 'keys-a', NOTE_ON(0));
  await expectStaysSilent(page, 'v2: channel 1 is filtered out');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(0));
  await holdUntilGateHigh(page, 'keys-a', NOTE_ON(4), 'v2: channel 5 drives the gate');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(4));
  await expectSilent(page, 'v2: note off');

  // THE SAME-SESSION LOAD of v1 over the running v2 rack, ids reused.
  await loadSameSession(page, envV1, ['mcb', 'scp']);
  expect(await readData(page, 'mcb', 'midiInChannel'), 'the doc shows v1').toBe(0);
  await holdUntilGateHigh(page, 'keys-a', NOTE_ON(0), 'AFTER THE LOAD: channel 1 (v1) drives the gate again');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(0));
  await expectSilent(page, 'after the load: note off');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_ON(4));
  await expectStaysSilent(page, 'AFTER THE LOAD: channel 5 (v2) is no longer heard — the stale filter is gone');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(4));
  expect(errors, errors.join(' | ')).toEqual([]);
});

// ── #4b midi-lane — the channel set ─────────────────────────────────────────

test('midi-lane: a same-session load restores the LOADED channel set — the gate follows it', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
  await installMidiDeviceMock(page, { outputs: [], inputs: [{ id: 'keys-a', name: 'Keys A' }] });
  const errors = await boot(page);
  await seedPatch(
    page,
    [
      { id: 'ml', type: 'midiLane', data: { channels: [0], lastDeviceId: 'keys-a', lastDeviceName: 'Keys A' } },
      { id: 'scp', type: 'scope' },
    ],
    [toScope('e-gate', 'ml', 'gate', 'gate')],
  );
  await connectMidi(page, 'ml');

  await holdUntilGateHigh(page, 'keys-a', NOTE_ON(0), 'v1: a channel-1 note raises the lane gate');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(0));
  await expectSilent(page, 'v1: note off');
  const envV1 = await saveEnvelope(page);

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { read: (n: unknown, k: string) => unknown };
      __patch: { nodes: Record<string, { data: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    (w.__engine().read(w.__patch.nodes['ml'], 'card-api') as { setChannels: (c: number[] | null) => void }).setChannels([9]);
    w.__ydoc.transact(() => { w.__patch.nodes['ml']!.data.channels = [9]; });
  });
  await injectMidiDeviceIn(page, 'keys-a', NOTE_ON(0));
  await expectStaysSilent(page, 'v2: channel 1 is outside the set');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(0));
  await holdUntilGateHigh(page, 'keys-a', NOTE_ON(9), 'v2: channel 10 drives the lane gate');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(9));
  await expectSilent(page, 'v2: note off');

  await loadSameSession(page, envV1, ['ml', 'scp']);
  await holdUntilGateHigh(page, 'keys-a', NOTE_ON(0), 'AFTER THE LOAD: channel 1 (v1) drives the lane gate again');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(0));
  await expectSilent(page, 'after the load: note off');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_ON(9));
  await expectStaysSilent(page, 'AFTER THE LOAD: channel 10 (v2) is no longer heard');
  await injectMidiDeviceIn(page, 'keys-a', NOTE_OFF(9));
  expect(errors, errors.join(' | ')).toEqual([]);
});

// ── #4c midi-out-buddy — the bytes on the wire ──────────────────────────────

/** The first NoteOn on `port` whose status byte is exactly `status`. */
async function waitForNoteOnStatus(page: Page, port: string, status: number, message: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([p, s]) => {
            const sent =
              (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
                .__midiOutSentDetailed ?? [];
            return sent.some((m) => m.portId === p && m.bytes[0] === s && (m.bytes[2] ?? 0) > 0);
          },
          [port, status] as const,
        ),
      { timeout: 20_000, message },
    )
    .toBe(true);
}

async function noteOnStatuses(page: Page, port: string): Promise<number[]> {
  return page.evaluate((p) => {
    const sent =
      (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
        .__midiOutSentDetailed ?? [];
    return sent
      .filter((m) => m.portId === p && (m.bytes[0]! & 0xf0) === 0x90 && (m.bytes[2] ?? 0) > 0)
      .map((m) => m.bytes[0]!);
  }, port);
}

test('midi-out-buddy: a same-session load restores the LOADED channel — NoteOn bytes carry it', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 4);
  await installMidiDeviceMock(page, { outputs: [{ id: 'synth-1', name: 'Synth' }], inputs: [] });
  const errors = await boot(page);
  // The REAL default-mode source: a self-running KRIA on gate + pitch.
  await seedPatch(
    page,
    [
      { id: 'seq', type: 'kria', params: { bpm: 240, running: 1 } },
      { id: 'mob', type: 'midiOutBuddy', data: { midiOutChannel: 1, lastDeviceId: 'synth-1', lastDeviceName: 'Synth' } },
    ],
    [
      { id: 'e-gate', from: { nodeId: 'seq', portId: 'gate1' }, to: { nodeId: 'mob', portId: 'gate' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e-pitch', from: { nodeId: 'seq', portId: 'pitch1' }, to: { nodeId: 'mob', portId: 'pitch' }, sourceType: 'cv', targetType: 'cv' },
    ],
  );
  await seedKriaWith(page, 'seq', buildKriaMidiData([72, 67, 64, 60], { duration: 0.5 }));
  await connectMidi(page, 'mob', 'synth-1');

  await waitForNoteOnStatus(page, 'synth-1', 0x90, 'v1: NoteOn on channel 1 reaches the wire');
  const envV1 = await saveEnvelope(page);

  // The FACE's edit path to v2 (channel 5).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { read: (n: unknown, k: string) => unknown };
      __patch: { nodes: Record<string, { data: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    (w.__engine().read(w.__patch.nodes['mob'], 'card-api') as { setChannel: (c: number) => void }).setChannel(5);
    w.__ydoc.transact(() => { w.__patch.nodes['mob']!.data.midiOutChannel = 5; });
  });
  await clearMidiOutCaptured(page);
  await waitForNoteOnStatus(page, 'synth-1', 0x94, 'v2: NoteOn on channel 5 reaches the wire');

  await loadSameSession(page, envV1, ['seq', 'mob']);
  await clearMidiOutCaptured(page);
  await waitForNoteOnStatus(page, 'synth-1', 0x90, 'AFTER THE LOAD: NoteOn on channel 1 (v1) is back on the wire');
  // From here every NoteOn must be v1's: one more sequencer step, then read.
  await clearMidiOutCaptured(page);
  await waitForNoteOnStatus(page, 'synth-1', 0x90, 'a second post-load channel-1 NoteOn');
  const statuses = await noteOnStatuses(page, 'synth-1');
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every((s) => s === 0x90), `every post-load NoteOn is on channel 1; saw ${statuses.map((s) => s.toString(16)).join(',')}`).toBe(true);
  expect(errors, errors.join(' | ')).toEqual([]);
});

// ── #4d midiclock — the bound port, and the LEGACY division (P1) ────────────

test('midiclock: a same-session load rebinds the LOADED port by name and re-reads a legacy division', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
  await installMidiDeviceMock(page, {
    outputs: [],
    inputs: [{ id: 's2-a', name: 'Drum Machine A' }, { id: 's2-b', name: 'Drum Machine B' }],
  });
  const errors = await boot(page);
  // v1 is a LEGACY rack: the division lives ONLY in `data.divisor` (no
  // `params.divisor`), and it is bound to port A.
  await seedPatch(
    page,
    [
      { id: 'mc', type: 'midiclock', params: {}, data: { divisor: 6, lastDeviceId: 's2-a', lastDeviceName: 'Drum Machine A' } },
      { id: 'scp', type: 'scope' },
    ],
    [toScope('e-run', 'mc', 'run', 'gate')],
  );
  await connectMidi(page, 'mc');
  // ⚠ THE HANDLE'S OWN DIVISION (`read('state').divisor`), never
  // `engine.readParam`: that answers from the knob CACHE, which `addNode`
  // seeds with the def DEFAULT for every param absent from `node.params` —
  // exactly the legacy shape — so it reports 24 while the clock divides by 6.
  const readDivisor = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine: () => { read: (n: unknown, k: string) => { divisor?: number } | undefined };
        __patch: { nodes: Record<string, unknown> };
      };
      return w.__engine().read(w.__patch.nodes['mc'], 'state')?.divisor;
    });
  expect(await readDivisor(), 'v1: the legacy division is honoured at spawn').toBe(6);

  // v1 LIVE: MIDI Start on port A raises RUN, read off the scope.
  await holdUntilGateHigh(page, 's2-a', [0xfa], 'v1: Start on port A raises RUN');
  await injectMidiDeviceIn(page, 's2-a', [0xfc]);
  await expectSilent(page, 'v1: Stop drops RUN');
  const envV1 = await saveEnvelope(page);

  // v2, the way the surfaces do it: the port picker (api + doc, with the
  // durable NAME) and the DIVISION cell (a param write the reconciler applies).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { read: (n: unknown, k: string) => unknown };
      __patch: { nodes: Record<string, { data: Record<string, unknown>; params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    (w.__engine().read(w.__patch.nodes['mc'], 'card-api') as { selectDevice: (d: string | null) => void }).selectDevice('s2-b');
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['mc']!;
      n.data.lastDeviceId = 's2-b';
      n.data.lastDeviceName = 'Drum Machine B';
      n.params.divisor = 24;
    });
  });
  await expect.poll(readDivisor, { message: 'v2: the param path applied 24' }).toBe(24);
  await holdUntilGateHigh(page, 's2-b', [0xfa], 'v2: Start on port B raises RUN');
  await injectMidiDeviceIn(page, 's2-b', [0xfc]);
  await expectSilent(page, 'v2: Stop drops RUN');

  // THE SAME-SESSION LOAD of the legacy v1 over the running v2 rack.
  await loadSameSession(page, envV1, ['mc', 'scp']);
  await expect
    .poll(readDivisor, { timeout: 10_000, message: 'AFTER THE LOAD: the legacy division (6) is re-read — no params.divisor for the reconciler to diff' })
    .toBe(6);
  await holdUntilGateHigh(page, 's2-a', [0xfa], 'AFTER THE LOAD: Start on port A (v1, rebound by NAME) raises RUN');
  await injectMidiDeviceIn(page, 's2-a', [0xfc]);
  await expectSilent(page, 'after the load: Stop on port A drops RUN');
  await injectMidiDeviceIn(page, 's2-b', [0xfa]);
  await expectStaysSilent(page, 'AFTER THE LOAD: port B (v2) is released — Start there does nothing');
  await injectMidiDeviceIn(page, 's2-b', [0xfc]);
  expect(errors, errors.join(' | ')).toEqual([]);
});

// ── #8 audio-out — the output sink ──────────────────────────────────────────

/** Record every `setSinkId` on the live AudioContext and grant the e2e ids.
 *  A CI runner has no second audio device, so the ids are synthetic; what is
 *  real is the CALL on the live context — the one owner of the sink. */
const SINK_SHIM = `
(() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  window.__sinkCalls = [];
  const orig = AC.prototype.setSinkId;
  AC.prototype.setSinkId = function (id) {
    window.__sinkCalls.push(id);
    if (typeof id === 'string' && id.startsWith('e2e-sink-')) return Promise.resolve();
    return typeof orig === 'function' ? orig.call(this, id) : Promise.resolve();
  };
})();
`;

test('audio-out: a same-session load re-applies the LOADED output device through setSinkId, and stays audible', async ({ page }) => {
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS * 3);
  await page.addInitScript({ content: SINK_SHIM });
  const errors = await boot(page);
  await seedPatch(
    page,
    [
      { id: 'noi', type: 'noise', params: { level: 0.5 } },
      { id: 'ao', type: 'audioOut', data: { outputDeviceId: 'e2e-sink-a' } },
    ],
    [{ id: 'e-out', from: { nodeId: 'noi', portId: 'white' }, to: { nodeId: 'ao', portId: 'L' }, sourceType: 'audio', targetType: 'audio' }],
  );
  await waitForHandle(page, 'ao', 'outputSink');

  const readSink = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine: () => { read: (n: unknown, k: string) => unknown };
        __patch: { nodes: Record<string, unknown> };
        __sinkCalls: string[];
      };
      const sink = w.__engine().read(w.__patch.nodes['ao'], 'outputSink') as {
        supported: boolean; deviceId: string | null; error: string | null;
      };
      return { ...sink, calls: [...w.__sinkCalls] };
    });
  const readRms = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine: () => { read: (n: unknown, k: string) => unknown };
        __patch: { nodes: Record<string, unknown> };
      };
      const snap = w.__engine().read(w.__patch.nodes['ao'], 'outputSnapshot') as { samples: Float32Array };
      let acc = 0;
      for (let i = 0; i < snap.samples.length; i++) acc += snap.samples[i]! * snap.samples[i]!;
      return Math.sqrt(acc / Math.max(1, snap.samples.length));
    });

  // v1 LIVE: the boot-time apply reaches the context.
  await expect.poll(async () => (await readSink()).deviceId, { message: 'v1: the saved sink is APPLIED at boot' }).toBe('e2e-sink-a');
  const v1 = await readSink();
  expect(v1.supported, 'setSinkId is present on the live context (shimmed on runners without it)').toBe(true);
  expect(v1.calls).toContain('e2e-sink-a');
  await expect.poll(readRms, { message: 'v1: the terminal is audible' }).toBeGreaterThan(0.01);
  const envV1 = await saveEnvelope(page);

  // The picker's edit path to v2: the handle write AND the doc.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { write: (n: unknown, k: string, v: unknown) => void };
      __patch: { nodes: Record<string, { data: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__engine().write(w.__patch.nodes['ao'], 'outputDeviceId', 'e2e-sink-b');
    w.__ydoc.transact(() => { w.__patch.nodes['ao']!.data.outputDeviceId = 'e2e-sink-b'; });
  });
  await expect.poll(async () => (await readSink()).deviceId, { message: 'v2: the picker applied its device' }).toBe('e2e-sink-b');
  const callsBeforeLoad = (await readSink()).calls.length;

  // THE SAME-SESSION LOAD of v1 over the running v2 rack.
  await loadSameSession(page, envV1, ['noi', 'ao']);
  expect(await readData(page, 'ao', 'outputDeviceId'), 'the doc shows v1 after the load').toBe('e2e-sink-a');
  await expect
    .poll(async () => (await readSink()).deviceId, { timeout: 10_000, message: 'AFTER THE LOAD: the loaded device (v1) is APPLIED, not merely persisted' })
    .toBe('e2e-sink-a');
  const after = await readSink();
  expect(after.error).toBeNull();
  expect(after.calls.slice(callsBeforeLoad), 'exactly one new setSinkId call, for the loaded device').toEqual(['e2e-sink-a']);
  await expect.poll(readRms, { message: 'after the load: the terminal is still audible through the reused node' }).toBeGreaterThan(0.01);
  expect(errors, errors.join(' | ')).toEqual([]);
});
