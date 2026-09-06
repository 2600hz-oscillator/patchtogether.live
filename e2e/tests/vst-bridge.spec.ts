// e2e/tests/vst-bridge.spec.ts
//
// VST BRIDGE cards against a MOCK helper — a real Node-side WebSocket server
// (../_helpers/mock-vst-bridge) speaking protocol v1 with real codecs, so the
// ENTIRE browser stack runs unmodified (owner → worker → SAB rings → worklet
// CV→MIDI) and only the AU plugin is faked. The page is pointed at the mock's
// ephemeral port via the `__vstBridgeUrlOverride` seam (bridge-client.ts).
//
// What this proves (the plan's M5 + the owner-named correctness):
//   fx:          transport round trip carries lane audio (echo), a mounted
//                plugin is IN the path (mute ⇒ silence), unmount restores it.
//   instrument:  the REAL default-mode note source (POLYSEQZ) → the module →
//                AUDIBLE RMS at the output (the poly-module rule), and the
//                notes ARRIVE AS THE RIGHT MIDI: c3/c4/a4 → 48/60/69, default
//                velocity 100 when vel is unpatched, and every NoteOn is
//                paired with a NoteOff once the transport stops (poly gates ≡
//                MIDI gates). hello.clientId is the graph node id.
//
// What it CANNOT see (owner-verify with the real helper + real AUs): native
// editor windows, AU state blobs, park/adopt across a reload, real plugin
// latency. Serial: one mock server per worker, sessions asserted by clientId.

import { test, expect } from './_fixtures';
import { spawnPatch, seedKriaGate } from './_helpers';
import {
  readScopePeakOverWindow,
  describeScopeWindow,
  setNodeParams,
} from './_module-coverage-helpers';
import { startMockVstBridge, type MockVstBridge } from '../_helpers/mock-vst-bridge';
import { chordVoicing } from '../../packages/web/src/lib/audio/poly';

const AUDIBLE_FLOOR = 0.01;
/** Bounds the failure, never the gate (untilPeak returns at first audible). */
const AUDIBLE_CAP_MS = 8_000;
const SILENCE_WINDOW_MS = 500;

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let mock: MockVstBridge;

test.beforeAll(async () => {
  mock = await startMockVstBridge();
});
test.afterAll(async () => {
  await mock?.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((url) => {
    (globalThis as unknown as { __vstBridgeUrlOverride?: string }).__vstBridgeUrlOverride = url;
  }, mock.url);
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
});


/** Open a vst node's dock full view and return the PANE — the face body
 *  (picker, mount/unmount, the three lamps) is `fullViewBody`, dock-only.
 *  The card's status/mounted/state-size text rows died with the card; their
 *  content lives verbatim in the lamps' aria-label sentences
 *  (vst-status-model.ts). */
async function openVstPane(page: import('@playwright/test').Page, id: string) {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);
  await expect(pane.getByTestId(`vst-face-body-${id}`)).toBeVisible({ timeout: 30_000 });
  return pane;
}

test('vstFx: helper echo carries lane audio; a mounted mute plugin is IN the path; unmount restores it', async ({ page }) => {
  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 60 } },
      { id: 'fx', type: 'vstFx', position: { x: 420, y: 60 } },
      { id: 'sc', type: 'scope', position: { x: 820, y: 60 }, params: { timeMs: 50 } },
    ],
    [
      { id: 'e_vco_fx', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'fx', portId: 'in_l' } },
      { id: 'e_fx_sc', from: { nodeId: 'fx', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' } },
    ],
  );

  // The factory auto-connects (owner acquire at reconcile) — the card reads
  // the mock's helperInfo name once the hello handshake lands.
  const fxPane = await openVstPane(page, 'fx');
  await expect(fxPane.getByTestId('vst-led-bridge-fx')).toHaveAttribute('aria-label', /mock-vst-bridge/, { timeout: 15_000 });

  // 1. CONNECTED + NOTHING MOUNTED: the bridge echoes bit-transparently, so
  //    the lane audio survives the round trip (rings → WS → mock → back).
  const echo = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
  expect(
    echo.peak,
    `unmounted fx should ECHO lane audio through the helper — ${describeScopeWindow(echo)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // 2. MOUNT the mute plugin THROUGH THE CARD UI: output goes silent —
  //    proving the helper path (not the local bypass) is what we hear.
  await fxPane.getByTestId('vst-face-picker-fx').selectOption('mock:mute');
  await fxPane.getByTestId('vst-face-mount-fx').click();
  await expect(fxPane.getByTestId('vst-led-plugin-fx')).toHaveAttribute('aria-label', /mock mute fx/, { timeout: 10_000 });
  await expect
    .poll(
      async () => (await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS)).peak,
      { timeout: 15_000, message: 'mounted mute plugin must silence the path (helper path live)' },
    )
    .toBeLessThan(AUDIBLE_FLOOR);

  // 2b. PERSISTENCE (M4): the mount + captured state land in node.data.vst
  //     (the driver's discrete-event writes), and the card paints the size.
  const persisted = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { vst?: { pluginId: string; stateB64?: string } } } | undefined> };
      };
      return w.__patch.nodes['fx']?.data?.vst ?? null;
    });
  await expect
    .poll(async () => (await persisted())?.pluginId ?? null, {
      timeout: 10_000,
      message: 'mounting must persist { pluginId } into node.data.vst',
    })
    .toBe('mock:mute');
  await expect
    .poll(async () => typeof (await persisted())?.stateB64, {
      timeout: 10_000,
      message: 'the driver must capture the plugin state blob after mount',
    })
    .toBe('string');
  await expect(fxPane.getByTestId('vst-led-plugin-fx')).toHaveAttribute('aria-label', /state travels with the patch/);

  // 3. UNMOUNT: back to the echo, lane audio returns — and the persisted
  //    record clears (explicit unmount is the ONLY clearing signal).
  await fxPane.getByTestId('vst-face-unmount-fx').click();
  await expect
    .poll(async () => await persisted(), { timeout: 10_000, message: 'explicit unmount clears node.data.vst' })
    .toBeNull();
  const back = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
  expect(
    back.peak,
    `unmount should restore the echo path — ${describeScopeWindow(back)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // Transport sanity on the mock side: this card's session pulled audio
  // blocks with an advancing sample clock, keyed by the node id.
  const session = mock.sessionFor('fx');
  expect(session, 'mock saw a session with clientId = the graph node id').toBeTruthy();
  expect(session!.blocksIn).toBeGreaterThan(0);
  expect(session!.lastSampleTime).toBeGreaterThan(0);
});

test('vstInstrument: kria-clocked cartesian → card → audible RMS; c3/c4/a4 arrive as MIDI 48/60/69, vel 100, gates paired', async ({ page }) => {
  await spawnPatch(
    page,
    [
      {
        id: 'seq-clk',
        type: 'kria',
        position: { x: 40, y: 460 },
        // running starts 0 — the transport starts AFTER the cells are
        // seeded, so no default-step note can leak into the MIDI log.
        params: { running: 0, bpm: 240 },
      },
      { id: 'seq', type: 'cartesian', position: { x: 40, y: 60 } },
      // keep the vst card fully clear of the sequencer subtrees or the
      // mount-button click is pointer-intercepted.
      { id: 'inst', type: 'vstInstrument', position: { x: 1500, y: 60 } },
      { id: 'sc', type: 'scope', position: { x: 2300, y: 60 }, params: { timeMs: 50 } },
    ],
    [
      {
        id: 'e_seq_clk',
        from: { nodeId: 'seq-clk', portId: 'gate1' },
        to: { nodeId: 'seq', portId: 'clock' },
        sourceType: 'gate',
        targetType: 'gate',
      },
      {
        id: 'e_seq_inst',
        from: { nodeId: 'seq', portId: 'pitch' },
        to: { nodeId: 'inst', portId: 'poly' },
        sourceType: 'polyPitchGate',
        targetType: 'polyPitchGate',
      },
      { id: 'e_inst_sc', from: { nodeId: 'inst', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' } },
    ],
  );

  // Seed the OWNER-NAMED roots on the real source: c3, c4, a4. CARTESIAN's
  // maj chord is the closed triad ([0,4,7] in chord-tables.ts), so each pad
  // on the clocked diagonal walk (0, 5, 10, 15) proves BOTH halves of the
  // owner ask at the wire: the roots land as MIDI 48/60/69, and the chord's
  // other voices ride their own poly voice-pairs into their own
  // NoteOn/NoteOff pairs (48,52,55 / 60,64,67 / 69,73,76). Pad 15 is OFF —
  // one silent step per cycle. (Was POLYSEQZ until its deletion 2026-08-24.)
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const t = w.__patch.nodes[id];
      if (!t) return;
      if (!t.data) t.data = {};
      const roots: Record<number, number> = { 0: 48, 5: 60, 10: 69 };
      (t.data as Record<string, unknown>).cells = Array.from({ length: 16 }, (_, i) => (
        i in roots
          ? { on: true, midi: roots[i], chord: 'maj' }
          : { on: false, midi: 60, chord: 'mono' }
      ));
    });
  }, 'seq');
  await seedKriaGate(page, 'seq-clk');

  const instPane = await openVstPane(page, 'inst');
  await expect(instPane.getByTestId('vst-led-bridge-inst')).toHaveAttribute('aria-label', /mock-vst-bridge/, { timeout: 15_000 });

  // Mount the sine instrument through the card UI.
  await instPane.getByTestId('vst-face-picker-inst').selectOption('mock:sine');
  await instPane.getByTestId('vst-face-mount-inst').click();
  await expect(instPane.getByTestId('vst-led-plugin-inst')).toHaveAttribute('aria-label', /mock sine synth/, { timeout: 10_000 });

  // Everything is wired and mounted — start the transport.
  await setNodeParams(page, 'seq-clk', { running: 1 });

  // THE POLY RULE: real default-mode source → module → AUDIBLE RMS at the
  // output. (Engine-direct synthetic tests shipped silent bugs 5× — this is
  // the real chain, with only the plugin faked behind the real wire.)
  const w = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
  expect(
    w.peak,
    `clip notes should sound through the mounted instrument — ${describeScopeWindow(w)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);

  // NOTE MAPPING (owner-verbatim): c3 = −1.0 CV → 48, c4 = 0.0 → 60,
  // a4 = +0.75 → 69 — asserted at the WIRE, after the worklet's CV→MIDI.
  // The expected set is DERIVED from chordVoicing — the SAME function
  // CARTESIAN calls per pad (root/3rd/5th/octave, poly.ts) — so this pins
  // "what the source emitted is exactly what the plugin heard", note for
  // note, with the three roots present by construction. (The old derivation
  // used chord-tables' chordToVoices, POLYSEQZ's 5-lane voicing — one note
  // wide of what CARTESIAN actually sends.)
  const EXPECTED_NOTES = [
    ...new Set(
      [48, 60, 69].flatMap((root) =>
        chordVoicing(root, 'maj')
          .filter((l) => l.gate === 1 && l.midi !== null)
          .map((l) => l.midi!),
      ),
    ),
  ].sort((a, b) => a - b);
  for (const root of [48, 60, 69]) expect(EXPECTED_NOTES).toContain(root);
  const noteSet = () => {
    const s = mock.sessionFor('inst');
    if (!s) return [] as number[];
    return [...new Set(
      s.midi.filter((e) => ((e.bytes[0] ?? 0) & 0xf0) === 0x90 && (e.bytes[2] ?? 0) > 0)
        .map((e) => e.bytes[1] ?? -1),
    )].sort((a, b) => a - b);
  };
  await expect
    .poll(noteSet, {
      timeout: 20_000,
      message: `c3/c4/a4 voicings must arrive as exactly MIDI [${EXPECTED_NOTES.join(', ')}]`,
    })
    .toEqual(EXPECTED_NOTES);

  // VELOCITY: vel input unpatched ⇒ every NoteOn carries DEFAULT_VELOCITY 100.
  const session = mock.sessionFor('inst')!;
  const badVel = session.midi
    .filter((e) => ((e.bytes[0] ?? 0) & 0xf0) === 0x90 && (e.bytes[2] ?? 0) > 0)
    .filter((e) => e.bytes[2] !== 100);
  expect(badVel, 'unpatched vel ⇒ MIDI velocity 100 on every NoteOn').toEqual([]);

  // GATES ≡ MIDI GATES: stop the transport; every sounding note must be
  // released — NoteOn and NoteOff counts pair up per note number.
  await setNodeParams(page, 'seq-clk', { running: 0 });
  await expect
    .poll(
      () => {
        const s = mock.sessionFor('inst');
        if (!s) return 'no session';
        const ons = new Map<number, number>();
        const offs = new Map<number, number>();
        for (const e of s.midi) {
          const status = (e.bytes[0] ?? 0) & 0xf0;
          const note = e.bytes[1] ?? -1;
          if (status === 0x90 && (e.bytes[2] ?? 0) > 0) ons.set(note, (ons.get(note) ?? 0) + 1);
          else if (status === 0x80 || status === 0x90) offs.set(note, (offs.get(note) ?? 0) + 1);
        }
        const unpaired = [...ons].filter(([n, c]) => (offs.get(n) ?? 0) !== c);
        return unpaired.map(([n, c]) => `${n}: ${c} on / ${offs.get(n) ?? 0} off`).join(', ') || 'paired';
      },
      { timeout: 10_000, message: 'after transport stop, every NoteOn must have its NoteOff' },
    )
    .toBe('paired');

  // Session identity: hello.clientId is the graph node id (the park/adopt key).
  expect(session.clientId).toBe('inst');
});

test('same-session LOAD over a live vst instance: swap-mount + loaded state applied + doc keeps the loaded record; an empty record unmounts', async ({ page }) => {
  // THE LOAD-STALENESS FIX (vst-persistence.ts syncExternalRecord), driven
  // through the REAL product path: `__persistence.save()` → user swaps the
  // plugin → same-session `__persistence.load()`. loadEnvelopeIntoStore
  // deletes + re-inserts every node in ONE transaction at reused ids, the
  // reconciler re-materializes nothing, and the driver + socket + mounted
  // plugin all SURVIVE the load. Pre-fix the driver never re-read `data.vst`:
  // the mute plugin kept playing (SILENT lane — this test's discriminator)
  // and the next state capture persisted mock:mute back over the loaded
  // record, silently reverting the load in the doc.
  test.setTimeout(180_000);
  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco', position: { x: 40, y: 60 } },
      { id: 'fx', type: 'vstFx', position: { x: 420, y: 60 } },
      { id: 'sc', type: 'scope', position: { x: 820, y: 60 }, params: { timeMs: 50 } },
    ],
    [
      { id: 'e_vco_fx', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'fx', portId: 'in_l' } },
      { id: 'e_fx_sc', from: { nodeId: 'fx', portId: 'out_l' }, to: { nodeId: 'sc', portId: 'ch1' } },
    ],
  );
  const fxPane = await openVstPane(page, 'fx');
  await expect(fxPane.getByTestId('vst-led-bridge-fx')).toHaveAttribute('aria-label', /mock-vst-bridge/, { timeout: 15_000 });

  const saveEnvelope = () =>
    page.evaluate(() => {
      const w = window as unknown as { __persistence?: { save?: () => unknown } };
      return w.__persistence?.save?.();
    });
  const loadEnvelope = (env: unknown) =>
    page.evaluate((e) => {
      const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown } };
      w.__persistence!.load!(e);
    }, env);
  const persisted = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { vst?: { pluginId: string; stateB64?: string } } } | undefined> };
      };
      return w.__patch.nodes['fx']?.data?.vst ?? null;
    });

  // Envelope A: NO plugin on the fx node.
  const envEmpty = await saveEnvelope();
  expect(envEmpty, '__persistence.save() unavailable — DEV build expected').toBeTruthy();

  // Envelope B: mock:gain mounted (echo-through render path), state captured.
  await fxPane.getByTestId('vst-face-picker-fx').selectOption('mock:gain');
  await fxPane.getByTestId('vst-face-mount-fx').click();
  await expect
    .poll(async () => (await persisted())?.pluginId ?? null, { timeout: 10_000, message: 'gain mount must persist' })
    .toBe('mock:gain');
  await expect
    .poll(async () => typeof (await persisted())?.stateB64, { timeout: 10_000, message: 'gain state must be captured before the save' })
    .toBe('string');
  const envGain = await saveEnvelope();

  // The user swaps to the MUTE plugin: the lane goes silent, the doc says mute.
  await fxPane.getByTestId('vst-face-picker-fx').selectOption('mock:mute');
  await fxPane.getByTestId('vst-face-mount-fx').click();
  await expect(fxPane.getByTestId('vst-led-plugin-fx')).toHaveAttribute('aria-label', /mock mute fx/, { timeout: 10_000 });
  await expect
    .poll(
      async () => (await readScopePeakOverWindow(page, 'sc', SILENCE_WINDOW_MS)).peak,
      { timeout: 15_000, message: 'mounted mute plugin must silence the path before the load' },
    )
    .toBeLessThan(AUDIBLE_FLOOR);

  // SAME-SESSION LOAD of the gain patch over the live mute instance.
  const statesBefore = mock.sessionFor('fx')!.setStates.length;
  await loadEnvelope(envGain);
  // 1. The swap reaches the HELPER (pre-fix: mountedId stays mock:mute).
  await expect
    .poll(() => mock.sessionFor('fx')?.mountedId ?? null, {
      timeout: 15_000,
      message: 'the loaded plugin must be mounted on the helper without a reconnect',
    })
    .toBe('mock:gain');
  // 2. The loaded patch's stored state is applied to OUR mount.
  await expect
    .poll(() => mock.sessionFor('fx')!.setStates.length, {
      timeout: 10_000,
      message: 'the loaded stateB64 must reach the plugin via setState',
    })
    .toBeGreaterThan(statesBefore);
  // 3. AUDIBLE again — mock:gain renders the echo path, mute rendered silence.
  const back = await readScopePeakOverWindow(page, 'sc', AUDIBLE_CAP_MS, { untilPeak: AUDIBLE_FLOOR });
  expect(
    back.peak,
    `the loaded gain plugin must carry lane audio — ${describeScopeWindow(back)}`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
  // 4. The DOC keeps the LOADED record — no silent revert to mock:mute.
  await expect
    .poll(async () => (await persisted())?.pluginId ?? null, {
      timeout: 10_000,
      message: 'data.vst must keep the loaded pluginId (no persist-over revert)',
    })
    .toBe('mock:gain');

  // LOAD of the EMPTY patch: the plugin unmounts, the record stays empty.
  await loadEnvelope(envEmpty);
  await expect
    .poll(() => mock.sessionFor('fx')?.mountedId ?? null, {
      timeout: 15_000,
      message: 'an empty loaded record must unmount the live plugin',
    })
    .toBeNull();
  await expect
    .poll(async () => await persisted(), {
      timeout: 10_000,
      message: 'data.vst must stay empty after the empty load (no resurrection)',
    })
    .toBeNull();
});
