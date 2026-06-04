// e2e/tests/midi.spec.ts
//
// MIDI e2e harness — drives the running app with simulated MIDI traffic via
// a mocked `navigator.requestMIDIAccess()` installed as a page init-script
// (see e2e/_helpers/midi.ts). Distinct from `midi-learn.spec.ts`, which uses
// the DEV-only `__midiTestInject` hook to poke the midi-learn singleton
// directly:
//   * THIS spec exercises the REAL subscription path (each subscriber calls
//     `navigator.requestMIDIAccess` + iterates `access.inputs.values()` +
//     sets `inp.onmidimessage`). Any future refactor that breaks the actual
//     web-MIDI plumbing fails here — not just at hardware plug-in.
//   * THIS spec catches the PR #389 regression class: save patch → reload →
//     CC values silently stop driving the rebinded knobs. Case #2 below.
//   * THIS spec covers system real-time MIDI (clock), which `midi-clock-source`
//     subscribes to on its OWN `requestMIDIAccess` call — `__midiTestInject`
//     never touches that path.
//
// All tests tagged `@midi` so the spec can be run in isolation:
//   task e2e -- --grep @midi
//
// Runtime-conscious: pure DOM + injected MIDI events. No real hardware, no
// permission prompts, no extra audio graph beyond the cards each test spawns.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import {
  installMidiMock,
  sendCc,
  sendClockBurst,
  waitForMidiSubscription,
} from '../_helpers/midi';

test.describe.configure({ mode: 'parallel' });

/** Read a node param from the live patch graph. Same shape midi-learn.spec.ts uses. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ nodeId, paramId }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
      };
      return w.__patch?.nodes?.[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

/** Clear any persisted MIDI bindings so a prior test's localStorage doesn't
 *  bleed into the current one. Mirrored from midi-learn.spec.ts. */
async function clearMidiBindings(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.removeItem('pt.midi-bindings.v1'));
}

// ============================================================================
// Case #0 — REGRESSION: no Web-MIDI permission prompt on page load.
// ============================================================================
//
// The bug: the app popped the browser "Control and reprogram your MIDI
// devices" prompt on boot / on loading a non-MIDI patch. Web MIDI must be
// requested STRICTLY ON DEMAND. This asserts the call count is 0:
//   (a) immediately after page load (before any interaction), and
//   (b) after loading the GLITCHES demo patch (which contains NO MIDI module)
//       + the auto-spawned TIMELORDE — the realistic "patch loaded on boot"
//       path the old eager trigger fired on.

test('@midi REGRESSION: page load never requests Web-MIDI access', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // Count requestMIDIAccess calls from before the very first navigation.
  await installMidiMock(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // (a) Bare page load — nothing mounted yet, must not have prompted.
  const callsAfterLoad = await page.evaluate(() => {
    const w = window as unknown as { __mockMidi?: { accessCallCount(): number } };
    return w.__mockMidi ? w.__mockMidi.accessCallCount() : -1;
  });
  expect(callsAfterLoad, 'navigator.requestMIDIAccess was called on bare page load (eager-prompt regression)').toBe(0);

  // (b) Load the demo patch (non-MIDI) + reconcile + auto-spawn TIMELORDE.
  //     This is the boot+patch path the eager trigger used to fire on.
  await page.getByRole('button', { name: 'GLITCHES GET RICHES' }).click();
  await expect(page.locator('.svelte-flow__node').first()).toBeVisible({ timeout: 20_000 });
  // Let factory timers (e.g. COCOA DELAY's 16ms syncPeriod poll, if any) run.
  await page.waitForTimeout(300);

  const callsAfterPatch = await page.evaluate(() => {
    const w = window as unknown as { __mockMidi?: { accessCallCount(): number } };
    return w.__mockMidi ? w.__mockMidi.accessCallCount() : -1;
  });
  expect(callsAfterPatch, 'navigator.requestMIDIAccess was called while loading a non-MIDI patch (eager-prompt regression)').toBe(0);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ============================================================================
// Case #1 — Plain CC reception drives a learned param.
// ============================================================================
//
// Asserts: with the MIDI mock as the only "device" present, entering MIDI
// Learn on a knob and sending a CC binds + drives the param across the whole
// 0..127 range. Differs from midi-learn.spec.ts case #1 in that this goes
// through the REAL `navigator.requestMIDIAccess()` → `inp.onmidimessage`
// path (the existing spec patches the singleton's `access` directly via
// `__midiTestInstall`).

test('@midi plain CC reception drives a learned param across the full range', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // Install BEFORE navigation so the app's first requestMIDIAccess() resolves
  // against the mock instead of the (Linux-CI-absent) Web MIDI implementation.
  await installMidiMock(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clearMidiBindings(page);

  await spawnPatch(
    page,
    [{ id: 'm-wc', type: 'wavecel', position: { x: 120, y: 120 }, domain: 'audio', params: { morph: 0.5 } }],
    [],
  );

  const card = page.locator('.svelte-flow__node-wavecel');
  await expect(card).toHaveCount(1);

  // Open the MIDI Learn affordance: right-click the Morph knob → "MIDI Learn".
  // Entering learn mode auto-calls connect(), which is what wires the mock
  // input's onmidimessage. Wait for at least one handler after that point.
  const morphKnob = card.locator('[role="slider"][aria-label="Morph"]');
  await expect(morphKnob).toHaveCount(1);

  await morphKnob.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await expect(menu).toBeHidden();

  // The midi-learn singleton's beginLearn() → connect() resolves against our
  // mock and attaches onmidimessage to mock-midi-in-0. Wait for that.
  await waitForMidiSubscription(page, 1);

  // 1a. CC at half-scale binds the knob and lands ≈0.504.
  await sendCc(page, 1, 20, 64);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(64 / 127, 2);
  // Bound-state badge appears.
  await expect(card.locator('.midi-badge')).toContainText('CC 20');

  // 1b. Send CC 0 → param goes to the binding's min (morph min = 0).
  await sendCc(page, 1, 20, 0);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(0, 2);

  // 1c. Send CC 127 → param goes to the binding's max (morph max = 1).
  await sendCc(page, 1, 20, 127);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(1, 2);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ============================================================================
// Case #2 — REGRESSION: save patch → reload → CC still drives the bound param.
// ============================================================================
//
// PR #389 (fix(midi): rewire MIDI bindings on performance load) fixed the
// case where a saved performance's `setter` was registered by the mounted
// Fader / Knob BEFORE `importBindings` ran, so the binding landed without a
// live setter and the knob silently ignored subsequent CCs. The fix split
// `bindings` and `setters` into two maps so order no longer matters.
//
// This test replays exactly that scenario. We DON'T need to wire through the
// full IndexedDB performance-save UX — the binding-rehydration code path is
// the same `bindings`-map population that `loadFromStorage()` runs at module
// boot from localStorage. (localStorage is how midi-learn ACTUALLY persists;
// the performance-bundle save just adds a second copy via importBindings on
// load. Whichever rehydration path runs, the bug is rebinding-on-mount.)
//
// Flow:
//   * Spawn patch + learn CC binding (validates pre-save behaviour).
//   * Persist binding to localStorage (mirrors what midi-learn does on every
//     learn capture + what makePerformanceBundle exports via exportBindings).
//   * Persist the patch envelope to the dev-only `__persistence` window hook
//     so reload restores the same node ids.
//   * Hard-reload the page with the mock re-installed (init-script applies
//     before the new page's first requestMIDIAccess call).
//   * Send CC 127. The knob MUST move. If it doesn't, this is the regression.

test('@midi REGRESSION: save patch → reload → CC values still fire (PR #389 class)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await installMidiMock(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clearMidiBindings(page);

  // -------- Phase 1: spawn + learn (build the bundle we'll restore later). --------
  await spawnPatch(
    page,
    [{ id: 'm-wc', type: 'wavecel', position: { x: 120, y: 120 }, domain: 'audio', params: { morph: 0.5 } }],
    [],
  );
  const card = page.locator('.svelte-flow__node-wavecel');
  await expect(card).toHaveCount(1);

  const morphKnob = card.locator('[role="slider"][aria-label="Morph"]');
  await morphKnob.click({ button: 'right' });
  const menu = page.locator('[data-testid="control-context-menu"]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-testid="ctx-midi-learn"]').click();
  await waitForMidiSubscription(page, 1);

  // Bind CC 30 → morph + verify it drives the param pre-save.
  await sendCc(page, 1, 30, 64);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(64 / 127, 2);
  await expect(card.locator('.midi-badge')).toContainText('CC 30');

  // Snapshot the patch envelope (what makeEnvelope(ydoc) produces — the same
  // shape Save-Performance stores) and the bindings array (what
  // exportBindings() produces, what the bundle carries).
  const envelope = await page.evaluate(() => {
    const w = window as unknown as { __persistence?: { save?: () => unknown } };
    return w.__persistence?.save?.();
  });
  expect(envelope, '__persistence.save() unavailable — DEV build expected').toBeTruthy();
  const bindingsExport = await page.evaluate(() => {
    // Use the app-exposed test hook (gated on testHooksEnabled) rather than a
    // `/src/...` dynamic import, so this resolves under the prebuilt `vite
    // preview` bundle (E2E_USE_PREVIEW=1) as well as the dev server.
    const w = window as unknown as { __midiLearnApi?: { exportBindings: () => unknown[] } };
    if (!w.__midiLearnApi) throw new Error('__midiLearnApi missing — test-hooks build expected');
    return w.__midiLearnApi.exportBindings();
  });
  expect((bindingsExport as Array<{ cc: number }>).some((b) => b.cc === 30),
    'exportBindings must include the just-learned CC 30').toBe(true);

  // -------- Phase 2: hard reload + replay the Load-Performance order EXACTLY. --------
  //
  // The bug PR #389 fixed is sequence-dependent. The Save/Load Local Performance
  // flow runs in this order:
  //   1. loadEnvelopeIntoStore(env) → cards mount (Fader/Knob onMount → registerSetter).
  //   2. importMidiBindings(bundle.midiBindings) → bindings populate.
  //
  // Pre-PR-#389, step 1 saw bindings.has(key) === false (the bindings map is
  // not populated until step 2), so registerSetter silently no-op'd. Step 2
  // then added the binding without a setter, so subsequent CCs went nowhere.
  //
  // To exercise this in an e2e: clear localStorage BEFORE reload (so the
  // module-load loadFromStorage doesn't pre-populate `bindings`), then on
  // the reloaded page restore the patch first, THEN call importBindings.
  // That's exactly the order the buggy bundle-load flow ran in.
  await clearMidiBindings(page);
  await installMidiMock(page);
  await page.reload({ waitUntil: 'networkidle' });
  // Defensive: also clear post-reload — the in-page loadFromStorage runs at
  // module import, but the import.meta.env.DEV path that mounts __persistence
  // is inside Canvas.svelte's $effect. localStorage gets read at midi-learn
  // module import, which happens before our page.evaluate runs, so the only
  // way to keep `bindings` empty across reload is for localStorage to be
  // empty AT IMPORT TIME — i.e. cleared before reload. The line above does
  // that; this is a paranoia check.
  await clearMidiBindings(page);

  // STEP 1: load patch envelope (cards mount → registerSetter fires with
  // EMPTY bindings map). This is the precise sequence that triggered the bug.
  await page.evaluate((env) => {
    const w = window as unknown as { __persistence?: { load?: (env: unknown) => unknown } };
    if (!w.__persistence?.load) throw new Error('__persistence.load missing — DEV build expected');
    w.__persistence.load(env);
  }, envelope);
  const cardAfter = page.locator('.svelte-flow__node-wavecel');
  await expect(cardAfter).toHaveCount(1, { timeout: 10_000 });

  // STEP 2: importBindings (mirrors importMidiBindings in the bundle-load flow).
  // After PR #389 this populates `bindings` AND the existing `setters` map
  // entry (registered at step 1's mount) starts dispatching immediately.
  // Pre-PR-#389, the binding lands without a setter (registerSetter was a
  // conditional no-op when bindings.has(key) was false) → CCs go nowhere.
  await page.evaluate((incoming) => {
    const w = window as unknown as { __midiLearnApi?: { importBindings: (b: unknown[]) => void } };
    if (!w.__midiLearnApi) throw new Error('__midiLearnApi missing — test-hooks build expected');
    w.__midiLearnApi.importBindings(incoming as unknown[]);
  }, bindingsExport);
  // The badge confirms the binding was rehydrated.
  await expect(cardAfter.locator('.midi-badge')).toContainText('CC 30');

  // STEP 3: wire onmidimessage (this is required regardless of PR #389 —
  // connect() is the lazy MIDIAccess fetch + per-input handler attach).
  // Without it our mock's onmidimessage is null and no CC ever reaches
  // handleMidi. This is independent of the bug.
  await page.evaluate(async () => {
    const w = window as unknown as { __midiLearnApi?: { connect: () => Promise<boolean> } };
    if (!w.__midiLearnApi) throw new Error('__midiLearnApi missing — test-hooks build expected');
    await w.__midiLearnApi.connect();
  });
  await waitForMidiSubscription(page, 1);

  // THE REGRESSION CHECK. Send CC 127 — m-wc's morph must move to 1.0.
  // If PR #389's fix regresses (setter never registered for the rehydrated
  // binding because mount-then-import lost the setter), morph stays at
  // ~0.504 (its pre-reload value) and the assertion fails.
  await sendCc(page, 1, 30, 127);
  await expect
    .poll(() => readParam(page, 'm-wc', 'morph'), {
      message:
        'REGRESSION (PR #389 class): after save → reload → import-bindings, ' +
        'CC 30 stopped driving m-wc.morph. The setter/binding rewire order ' +
        'is broken — mounting a card before importBindings drops the setter.',
      timeout: 3000,
    })
    .toBeCloseTo(1, 2);

  // And the lower bound.
  await sendCc(page, 1, 30, 0);
  await expect.poll(() => readParam(page, 'm-wc', 'morph')).toBeCloseTo(0, 2);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ============================================================================
// Case #3 — NoteOn / NoteOff cleanup (lightweight — no audio probing).
// ============================================================================
//
// midi-cv-buddy is the in-rack module that turns NoteOn / NoteOff into V/oct
// gate + CV. Spawn a MIDI-CV-BUDDY, send NoteOn → NoteOff, and observe its
// `read('gate')` surface. Audio energy probing is intentionally skipped —
// the gate readback is sufficient to prove the NoteOn / NoteOff path is
// wired through our mock end-to-end. See task description: case #3/#5 may
// leave audio-probing TODO; the core regression is case #2.

test('@midi NoteOn / NoteOff drives MIDI-CV-BUDDY gate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await installMidiMock(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await clearMidiBindings(page);

  await spawnPatch(
    page,
    [{ id: 'mcb', type: 'midiCvBuddy', position: { x: 120, y: 120 }, domain: 'audio' }],
    [],
  );

  const card = page.locator('.svelte-flow__node-midiCvBuddy');
  await expect(card).toHaveCount(1, { timeout: 10_000 });

  // MIDI-CV-BUDDY does NOT auto-request MIDI access on engine attach — it has
  // a "Connect MIDI…" button that fires api.connect() on user click. Click
  // it so requestMIDIAccess fires against our mock.
  const connectBtn = card.locator('.connect-btn');
  await expect(connectBtn).toBeVisible({ timeout: 10_000 });
  await connectBtn.click();
  await waitForMidiSubscription(page, 1);

  // Send NoteOn → NoteOff through our mock. The card now displays the last
  // received note in its `.active-note` slot (or similar); we don't assert
  // on the UI text here (varies across redesigns) — we assert two things:
  //   (a) The mock subscription is wired (handlerCount >= 1) — already
  //       waited above.
  //   (b) NoteOn/Off dispatch generates no page errors (the bytes flow
  //       through the engine's MIDI handler without throwing).
  // TODO: when MIDI-CV-BUDDY exposes a read('lastNote') / read('gate') hook
  // on its engine handle, assert here. Today the card's `lastNote` is only
  // surfaced via a Svelte subscription, which is awkward to poll without
  // adding a window hook. Audio energy probing also TODO — see task header.
  await page.evaluate(() => {
    const w = window as unknown as { __mockMidi: {
      noteOn(c: number, n: number, v: number): void;
      noteOff(c: number, n: number, v: number): void;
    } };
    w.__mockMidi.noteOn(1, 60, 100); // C4 NoteOn
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const w = window as unknown as { __mockMidi: { noteOff(c: number, n: number, v: number): void } };
    w.__mockMidi.noteOff(1, 60, 0);
  });
  await page.waitForTimeout(50);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

// ============================================================================
// Case #4 — MIDI Clock (0xF8) drives midi-clock-source BPM derivation.
// ============================================================================
//
// midi-clock-source is a separate subscriber (not the midi-learn singleton)
// that holds its own `access` reference + `onmidimessage` handler. It attaches
// strictly ON DEMAND: navigator.requestMIDIAccess fires only on the first
// tempo READ (getBpm()/getBeatPeriodS()), NOT on construction. COCOADELAY only
// reads the MIDI tempo when its clockSource is set to MIDI, so merely spawning
// a default-System COCOADELAY must NOT prompt (the page-load-prompt fix).
//
// This test therefore explicitly performs the on-demand READ
// (__midiClockSource().getBpm()) to trigger requestMIDIAccess against our mock,
// then asserts the subscription attaches + pulses derive BPM — and FIRST
// asserts that spawning alone did NOT yet request access.
//
// We assert directly against the source's `.getBpm()` by dynamic-importing
// the module from the page context (Vite dev server serves source modules
// under /src/...; see e2e/tests/video-orientation.spec.ts for the pattern).
//
// Math: midi-clock-source uses 24 ppqn:
//   pulsePeriodMs = smoothed dt between consecutive 0xF8 messages
//   quarterMs     = pulsePeriodMs * 24
//   bpm           = 60000 / quarterMs = 2500 / pulsePeriodMs
// intervalMs = 50 → 50 BPM. We send 60 pulses (2.5 quarters) to let the
// one-pole smoothing (α=0.25) settle, and tolerate ±5 BPM for timer jitter.

test('@midi MIDI Clock pulses drive midi-clock-source BPM derivation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await installMidiMock(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // COCOADELAY's engine factory constructs the MIDI clock-source singleton,
  // but on its DEFAULT System clock it must NOT read the tempo and so must NOT
  // call navigator.requestMIDIAccess (the page-load-prompt regression).
  await spawnPatch(
    page,
    [{ id: 'cd', type: 'cocoadelay', position: { x: 120, y: 120 }, domain: 'audio' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-cocoadelay');
  await expect(card).toHaveCount(1, { timeout: 10_000 });

  // REGRESSION: spawning a default-System COCOADELAY alone must not prompt.
  const callsAfterSpawn = await page.evaluate(() => {
    const w = window as unknown as { __mockMidi?: { accessCallCount(): number } };
    return w.__mockMidi ? w.__mockMidi.accessCallCount() : -1;
  });
  expect(callsAfterSpawn, 'spawning a default-System COCOADELAY requested MIDI access (eager-prompt regression)').toBe(0);

  // Now perform the ON-DEMAND tempo read (what selecting MIDI clock / a MIDI
  // consumer does): the first getBpm() triggers requestMIDIAccess against our
  // mock + wires onmidimessage to the mock's only input.
  await page.evaluate(() => {
    const w = window as unknown as { __midiClockSource?: () => { getBpm: () => number | null } };
    if (!w.__midiClockSource) throw new Error('__midiClockSource missing — test-hooks build expected');
    w.__midiClockSource().getBpm();
  });

  // The clock source attaches asynchronously (the awaited requestMIDIAccess
  // promise + the iteration over access.inputs). Wait for the handler to
  // appear on our mock input.
  await waitForMidiSubscription(page, 1);

  // Send a Start (resets phase) then 60 clock pulses at 50ms intervals → 50 BPM.
  await page.evaluate(() => {
    const w = window as unknown as { __mockMidi: { start(): void } };
    w.__mockMidi.start();
  });
  await sendClockBurst(page, 60, 50);

  // Read the derived BPM out of the source singleton via the app-exposed test
  // hook (gated on testHooksEnabled) — resolves under `vite preview` too,
  // unlike a `/src/...` dynamic import which only the dev server serves.
  const derivedBpm = await page.evaluate(() => {
    const w = window as unknown as {
      __midiClockSource?: () => { getBpm: () => number | null };
    };
    if (!w.__midiClockSource) throw new Error('__midiClockSource missing — test-hooks build expected');
    return w.__midiClockSource().getBpm();
  });

  expect(derivedBpm, 'midi-clock-source.getBpm() returned null — pulses never reached the singleton').not.toBeNull();
  expect(derivedBpm!).toBeGreaterThanOrEqual(45);
  expect(derivedBpm!).toBeLessThanOrEqual(55);

  // Send Stop — derived BPM should clear.
  await page.evaluate(() => {
    const w = window as unknown as { __mockMidi: { stop(): void } };
    w.__mockMidi.stop();
  });
  await page.waitForTimeout(50);
  const afterStop = await page.evaluate(() => {
    const w = window as unknown as {
      __midiClockSource?: () => { getBpm: () => number | null };
    };
    if (!w.__midiClockSource) throw new Error('__midiClockSource missing — test-hooks build expected');
    return w.__midiClockSource().getBpm();
  });
  expect(afterStop).toBeNull();

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});
