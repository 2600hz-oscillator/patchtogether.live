import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, MOUNT_CAP_MS } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';


/** Cold boot: the navigation, then the topbar. Charged TWICE — the goto carries
 *  the cap too, since this suite's config sets no `navigationTimeout`. */
const BOOT_MS = 30_000;
/** The flow pane painting after the topbar — the last boot step. */
const PANE_MS = 15_000;
/** The live channel meter hearing the oscillator (the source positive control). */
const LIVE_METER_MS = 20_000;
/** The armed-while-stopped soak: several registry ticks with no transport. */
const STOPPED_SOAK_MS = 10_000;
/** The arm reaching `audioRec` once the transport plays (prepare → open → confirm). */
const PROJECT_MS = 25_000;
/** One musical loop, then the OPFS drain, the commit and its undo unit. */
const COMMIT_MS = 40_000;
/** A store value flips: a toggle write, a lane's playing slot, a pad attribute. */
const STATE_MS = 10_000;
/** One scope observation window. */
const AUDIBLE_MS = 8_000;
/** `expectSilence`: the settle poll, then the confirming window. */
const SILENCE_POLL_MS = 15_000;
const SILENCE_CONFIRM_MS = 1_200;
const SILENCE_MS = SILENCE_POLL_MS + SILENCE_CONFIRM_MS;
/** A single UI gesture — a click or a visibility wait. Explicit because this
 *  suite's config leaves `actionTimeout` unset, and an unbounded click eats the
 *  whole wall and blames the next line. */
const UI_MS = 5_000;

const TEST_BUDGET_MS =
  2 * BOOT_MS +
  PANE_MS +
  MOUNT_CAP_MS +
  LIVE_METER_MS +
  STOPPED_SOAK_MS +
  PROJECT_MS +
  COMMIT_MS +
  4 * STATE_MS +
  4 * AUDIBLE_MS +
  3 * SILENCE_MS +
  10 * UI_MS;

const TL = 'tl1';
const OSC = 'osc1';
const MIX = 'mx1';
const CP = 'cp1';
const SC = 'sc1';
/** A scope on the lane's own audio1L jack — the SAFER-BREAK leg's subject. */
const JACK = 'jack-scope';

/** The slot this journey records into. Deliberately NOT 0: slot 0 is both the
 *  default selection and what "first empty slot" would have picked, so a take
 *  landing there would prove nothing about clause 2. Slot 3 is only reachable
 *  by actually honouring the selection. */
const TARGET_SLOT = 3;
/** `clipIndex(slot, lane)` for lane 0 — the stride-64 storage key. */
const TARGET_INDEX = 0 * 64 + TARGET_SLOT;

/** Node data, deep-copied out of the live graph. */
async function readData(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, { data?: unknown }> } };
    return JSON.parse(JSON.stringify(w.__patch.nodes[id]?.data ?? {})) as Record<string, unknown>;
  }, nodeId);
}

/** The committed clip record at a flat index, or null. */
async function readClipAt(page: Page, index: number): Promise<Record<string, unknown> | null> {
  const d = await readData(page, CP);
  const clips = (d.clips ?? {}) as Record<string, unknown>;
  return (clips[String(index)] ?? null) as Record<string, unknown> | null;
}

/** The mixer's post-fader channel meters — the live-chain positive control. */
async function readChannelLevel(page: Page, ch0: number): Promise<number> {
  return await page.evaluate(
    ([mixId, c]) => {
      const w = window as unknown as {
        __engine?: () => { read(node: unknown, key: string): unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const mix = w.__patch.nodes[mixId as string];
      if (!eng || !mix) return 0;
      const levels = eng.read(mix, 'levels') as number[] | undefined;
      return levels?.[c as number] ?? 0;
    },
    [MIX, ch0] as const,
  );
}

/** Set the TIMELORDE transport running flag directly — the transport control is
 *  not this spec's subject and driving it through the deck would couple this
 *  journey to another surface's markup. */
async function setTransport(page: Page, running: boolean): Promise<void> {
  await page.evaluate(
    ([id, run]) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const n = w.__patch.nodes[id as string]!;
      w.__ydoc.transact(() => {
        if (!n.params) n.params = {};
        n.params.running = (run as boolean) ? 1 : 0;
      });
    },
    [TL, running] as const,
  );
}

/** Settle-then-confirm silence: poll SHORT windows until one reads quiet (a
 *  single sample can land on a sine's zero-crossing, and a long window that
 *  straddles the stop counts the loud head into its own rms), THEN assert a
 *  full fresh window — sample twice, assert on the second. */
async function expectSilence(page: Page, label: string): Promise<void> {
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, SC, 300)).rms, {
      message: `${label}: the clip output must settle to silence`,
      timeout: SILENCE_POLL_MS,
    })
    .toBeLessThan(0.02);
  const confirm = await readScopePeakOverWindow(page, SC, SILENCE_CONFIRM_MS, { minMs: 800 });
  expect(confirm.rms, `${label}: ${describeScopeWindow(confirm)}`).toBeLessThan(0.02);
}

/** Open the launcher's DOCK faceplate — the launch grid is a dock-only PF-14
 *  panel, so the lane tile alone never paints a pad. Scoped BY NODE so a second
 *  clip player could never satisfy the locator. */
async function openLauncher(page: Page): Promise<void> {
  const shell = page.locator(`.svelte-flow__node[data-id="${CP}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: UI_MS });
  await shell.getByTestId('shell-open-dock').click({ timeout: UI_MS });
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${CP}"]`);
  await expect(dockShell).toBeVisible({ timeout: UI_MS });
  const tab = page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="${CP}"]`)
    .getByTestId('faceplate-tab-session');
  await tab.click({ timeout: UI_MS });
  await expect(tab, 'the session page opens').toHaveAttribute('aria-selected', 'true', {
    timeout: STATE_MS,
  });
}

type CaptureSurface = 'screen' | 'push' | 'launchpad' | 'pair';
async function hardwareAudio(page: Page, surface: Exclude<CaptureSurface, 'screen'>, action: 'select' | 'arm' | 'transport' | 'source') {
  await page.evaluate(async ({ surface, action, nodeId, slot }) => {
    type Single = { press(x: number, y: number): void; cc(cc: number, value: number): void };
    type Pair = { pressL(x: number, y: number): void; pressR(x: number, y: number): void; ccR(cc: number, value: number): void };
    const w = window as unknown as {
      __push2TestInstall(id: string): Promise<boolean>; __push2Sim: Single;
      __launchpadTestInstallSingle(id: string): Promise<boolean>; __launchpadSingleSim: Single;
      __launchpadTestInstall(id: string): Promise<boolean>; __launchpadSim: Pair;
    };
    if (action === 'select') {
      const installed = surface === 'push' ? await w.__push2TestInstall(nodeId) : surface === 'pair' ? await w.__launchpadTestInstall(nodeId) : await w.__launchpadTestInstallSingle(nodeId);
      if (!installed) throw new Error(`Could not install simulated ${surface}`);
    }
    if (surface === 'pair') {
      const sim = w.__launchpadSim;
      if (action === 'select') { sim.pressR(4, 6); sim.pressR(0, 0); sim.pressL(slot, 7); }
      if (action === 'arm') sim.pressR(0, 6);
      if (action === 'transport') { sim.ccR(96, 127); sim.ccR(96, 0); }
      if (action === 'source') sim.pressR(0, 4);
    } else {
      const sim = surface === 'push' ? w.__push2Sim : w.__launchpadSingleSim;
      const cc = (value: number) => { sim.cc(value, 127); sim.cc(value, 0); };
      if (action === 'select') { cc(surface === 'push' ? 24 : 95); sim.press(4, 6); sim.press(0, 7 - slot); }
      if (action === 'arm') cc(surface === 'push' ? 43 : 89);
      if (action === 'transport') cc(surface === 'push' ? 85 : 91);
      if (action === 'source') cc(surface === 'push' ? 40 : 59);
    }
  }, { surface, action, nodeId: CP, slot: TARGET_SLOT });
}

/** Add (or, with null endpoints, remove) one audio cable in the live graph. */
async function setEdge(
  page: Page,
  id: string,
  from: { nodeId: string; portId: string } | null,
  to: { nodeId: string; portId: string } | null,
): Promise<void> {
  await page.evaluate(({ id, from, to }) => {
    const w = window as unknown as { __patch: { edges: Record<string, unknown> }; __ydoc: { transact(fn: () => void): void } };
    w.__ydoc.transact(() => {
      if (from && to) w.__patch.edges[id] = { id, source: from, target: to, sourceType: 'audio', targetType: 'audio' };
      else if (w.__patch.edges[id] !== undefined) delete w.__patch.edges[id];
    });
  }, { id, from, to });
}

for (const surface of ['screen', 'push', 'launchpad', 'pair'] as const) {
  test(`${surface}: a note clip records its own audio layer and plays through the still-patched mixer`, async ({ page }, testInfo) => {
    test.setTimeout(TEST_BUDGET_MS);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.text().includes('[clip-rec]')) console.log(m.text()); });
    await page.goto('/rack?seed=none', { timeout: BOOT_MS });
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    const notes = { kind: 'note', name: 'Source phrase', lengthSteps: 16, root: 60, scale: 'major', loop: true,
      steps: [0, 4, 8, 12].map(step => ({ step, midi: 60 + step, velocity: 110, lengthSteps: 2 })) };
    const auto = { tracks: { 'mx1::ch1_volume': { events: [{ step: 0, value: 0.8 }, { step: 8, value: 0.6 }] } } };
    await spawnPatch(page, [
      { id: TL, type: 'timelorde', position: { x: 0, y: 0 }, params: { running: 0, bpm: 120 } },
      { id: OSC, type: 'cube', position: { x: 0, y: 200 }, params: { attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 } },
      { id: MIX, type: 'mixmstrs', position: { x: 400, y: 0 } },
      { id: CP, type: 'clipplayer', position: { x: 400, y: 600 } },
      { id: SC, type: 'scope', position: { x: 900, y: 0 } },
      { id: 'live-scope', type: 'scope', position: { x: 900, y: 350 } },
      { id: JACK, type: 'scope', position: { x: 900, y: 700 } },
    ], [
      { id: 'poly', from: { nodeId: CP, portId: 'pitch1' }, to: { nodeId: OSC, portId: 'poly' }, sourceType: 'polyPitchGate', targetType: 'polyPitchGate' },
      { id: 'left', from: { nodeId: OSC, portId: 'L' }, to: { nodeId: MIX, portId: 'ch1L' } },
      { id: 'right', from: { nodeId: OSC, portId: 'R' }, to: { nodeId: MIX, portId: 'ch1R' } },
      { id: 'master-probe', from: { nodeId: MIX, portId: 'masterL' }, to: { nodeId: SC, portId: 'ch1' } },
      { id: 'live-probe', from: { nodeId: OSC, portId: 'L' }, to: { nodeId: 'live-scope', portId: 'ch1' } },
    ]);
    await page.evaluate(({ id, index, slot, notes, auto }) => {
      const w = window as unknown as { __patch: { nodes: Record<string, { data: unknown }> }; __ydoc: { transact(fn: () => void): void } };
      w.__ydoc.transact(() => { w.__patch.nodes[id]!.data = { sv: 2, clips: { [String(index)]: notes }, auto: { [String(index)]: auto }, playing: [slot, null, null, null, null, null, null, null] }; });
    }, { id: CP, index: TARGET_INDEX, slot: TARGET_SLOT, notes, auto });
    await openLauncher(page);
    if (surface === 'screen') await page.getByRole('combobox', { name: 'Inspect slot' }).selectOption({ value: String(TARGET_SLOT) });
    else await hardwareAudio(page, surface, 'select');
    const arm = page.getByTestId('clipplayer-rec-arm-0');
    if (surface === 'screen') await arm.click();
    else await hardwareAudio(page, surface, 'arm');
    await expect(arm).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('combobox', { name: 'Inspect slot' }).selectOption({ value: '5' });
    expect(((await readData(page, CP)).recRequest as Record<string, {slot: number}>)['0']?.slot).toBe(TARGET_SLOT);
    await page.getByRole('combobox', { name: 'Inspect slot' }).selectOption({ value: String(TARGET_SLOT) });
    await expectSilence(page, 'stopped transport');
    expect((await readData(page, CP)).audio ?? {}).toEqual({});
    expect((await readClipAt(page, TARGET_INDEX))?.kind).toBe('note');
    if (surface === 'screen') await setTransport(page, true);
    else await hardwareAudio(page, surface, 'transport');
    await expect.poll(() => readChannelLevel(page, 0), { timeout: LIVE_METER_MS,
      message: 'real clip notes must drive the poly instrument into the mixer' }).toBeGreaterThan(0.02);
    const take = async () => ((await readData(page, CP)).audio as Record<string, Record<string, unknown>> | undefined)?.[String(TARGET_INDEX)];
    await expect.poll(async () => (await take())?.mediaId, { timeout: COMMIT_MS }).toBeTruthy();
    const recorded = (await take())!;
    expect(recorded.kind).toBe('audio');
    expect(recorded.frames).toBe(Number(recorded.sampleRate) * 2);
    expect(await readClipAt(page, TARGET_INDEX)).toEqual(notes);
    expect(((await readData(page, CP)).auto as Record<string, unknown>)[String(TARGET_INDEX)]).toEqual(auto);
    expect(Object.keys((await readData(page, CP)).clips as object)).toEqual([String(TARGET_INDEX)]);
    await expect(arm).toHaveAttribute('aria-pressed', 'false');
    const pad = page.getByTestId(`clipplayer-pad-${TARGET_INDEX}`);
    await expect(pad).toHaveAttribute('data-audio', '1');
    await expect.poll(async () => (await readScopePeakOverWindow(page, SC, 800)).rms,
      { timeout: AUDIBLE_MS, message: 'recorded audio must reach the actual MIXMSTRS master, with both instrument cables still connected' }).toBeGreaterThan(0.02);
    await expect.poll(async () => (await readScopePeakOverWindow(page, 'live-scope', 500)).rms,
      { timeout: SILENCE_POLL_MS, message: 'Recorded stops the note-driven voice; it must not double the take' }).toBeLessThan(0.02);
    const voiceLevel = async (level: number) => page.evaluate(({ id, level }) => {
      const w = window as unknown as { __patch: {nodes: Record<string, {params: Record<string, number>}>}; __ydoc: {transact(fn: () => void): void} };
      w.__ydoc.transact(() => { w.__patch.nodes[id]!.params.level = level; });
    }, { id: OSC, level });
    await voiceLevel(0);
    await expect.poll(async () => (await readScopePeakOverWindow(page, SC, 800)).rms, { timeout: AUDIBLE_MS }).toBeGreaterThan(0.02);
    if (surface === 'screen') {
      // THE SAFER BREAK (owner, 2026-09-21): a cable leaving the lane's OWN
      // audio jack, to ANY destination, replaces the internal return so a
      // hand-routed take is never doubled. The voice is at 0 and RECORDED is
      // selected, so the master hears ONLY the internal return right now —
      // the jack must keep sounding while the master goes quiet, and
      // unpatching must bring the return back.
      await setEdge(page, 'jack', { nodeId: CP, portId: 'audio1L' }, { nodeId: JACK, portId: 'ch1' });
      await expect.poll(async () => (await readScopePeakOverWindow(page, JACK, 800)).rms, { timeout: AUDIBLE_MS,
        message: 'the take still plays out of the lane jack once it is patched' }).toBeGreaterThan(0.02);
      await expectSilence(page, 'a cable on the lane jack breaks the internal return, so the master goes quiet');
      await setEdge(page, 'jack', null, null);
      await expect.poll(async () => (await readScopePeakOverWindow(page, SC, 800)).rms, { timeout: AUDIBLE_MS,
        message: 'unpatching the jack restores the internal return' }).toBeGreaterThan(0.02);
    }
    if (surface === 'screen') await page.locator('[data-testid="clipplayer-source-notes"]:visible').click();
    else await hardwareAudio(page, surface, 'source');
    await expect(page.locator('[data-testid="clipplayer-source-notes"]:visible')).toHaveAttribute('aria-pressed', 'true');
    await expectSilence(page, 'Notes with the source instrument silenced');
    await voiceLevel(1);
    await expect.poll(async () => (await readScopePeakOverWindow(page, SC, 800)).rms, { timeout: AUDIBLE_MS,
      message: 'Notes regenerates audio through the same unchanged instrument cables' }).toBeGreaterThan(0.02);
    expect((await take())?.mediaId).toBe(recorded.mediaId);
    if (surface === 'screen') await page.locator('[data-testid="clipplayer-source-recorded"]:visible').click();
    else await hardwareAudio(page, surface, 'source');
    await pad.dblclick();
    await expect(page.locator('.waveform[data-media-state="ready"]')).toBeVisible({ timeout: STATE_MS });
    await expect(page.locator('[data-testid="clipplayer-audio-panel"]:visible')).toHaveAttribute('data-clip-kind', 'note');
    await page.locator('[data-testid="clipplayer-replace-take"]:visible').click();
    expect((await readData(page, CP)).recArm).toEqual({ '0': false });
    await expect(page.getByTestId('clipplayer-confirm-replace')).toBeVisible();
    await page.getByRole('button', { name: 'CANCEL', exact: true }).click();
    await page.getByTestId('dock-full-view').screenshot({ path: testInfo.outputPath('note-and-audio-layers.png') });
    expect(errors).toEqual([]);
  });
}
