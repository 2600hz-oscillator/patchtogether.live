// cliprec-endless.spec.ts
//
// CLAUSE 5, THE ENDLESS HALF — "keeps recording until transport stop is hit OR
// the lane's record button is tapped again, and in that case it keeps recording
// UNTIL THE END OF THE CURRENT LOOP of the underlying clip."
//
// ⚠ THE WHOLE-LOOP PROPERTY IS THE ASSERTION, and it needs a number, not a
// state. Stopping an endless take is only correct if the committed length is an
// EXACT WHOLE MULTIPLE of the clip's loop — a recorder that simply stopped when
// asked would produce a fractional take that still commits, still plays, still
// looks green, and is musically wrong forever after. So this spec runs past a
// loop boundary, taps the button mid-loop, and asserts the committed frame
// count is exactly n × unitFrames.
//
// ⚠ AND IT CARRIES ITS OWN NEGATIVE CONTROL, in the strong form: the stop is
// issued at a deliberately AWKWARD moment (well inside a loop, nowhere near a
// boundary), and the test asserts the take is NOT the length an immediate-stop
// implementation would produce. Asserting only "frames is a multiple of unit"
// would be satisfied by a stop that happened to land on a boundary; asserting
// the fractional length is ABSENT is what separates the two.
//
// This spec also exercises the take-losing defect fixed on 2026-09-04: the
// machine used to emit `[cancelWorklet, beginCommit]` here, a self-contradicting
// pair (cancel discards the lane silently and never reports `done`; the commit
// waits for `done`), so every endless take ended this way timed out and landed
// in the recovery pile instead of the clip. A commit arriving at all is the
// regression evidence.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, MOUNT_CAP_MS } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

const BOOT_MS = 30_000;
const PANE_MS = 15_000;
const LIVE_METER_MS = 20_000;
/** The arm reaching `audioRec` (prepare → media open → confirm). */
const PROJECT_MS = 25_000;
/** Long enough to run PAST one whole loop and well into the next. */
const LOOPS_MS = 40_000;
/** The truncate, the OPFS drain, the commit and its undo unit. */
const COMMIT_MS = 40_000;
const STATE_MS = 10_000;
const AUDIBLE_MS = 8_000;
const UI_MS = 5_000;

const TEST_BUDGET_MS =
  2 * BOOT_MS +
  PANE_MS +
  MOUNT_CAP_MS +
  LIVE_METER_MS +
  PROJECT_MS +
  LOOPS_MS +
  COMMIT_MS +
  4 * STATE_MS +
  AUDIBLE_MS +
  8 * UI_MS;

const TL = 'tl1';
const OSC = 'osc1';
const MIX = 'mx1';
const CP = 'cp1';
const SC = 'sc1';

const TARGET_SLOT = 2;
const TARGET_INDEX = 0 * 64 + TARGET_SLOT;

async function readData(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, { data?: unknown }> } };
    return JSON.parse(JSON.stringify(w.__patch.nodes[id]?.data ?? {})) as Record<string, unknown>;
  }, nodeId);
}

async function readClipAt(page: Page, index: number): Promise<Record<string, unknown> | null> {
  const d = await readData(page, CP);
  const clips = (d.clips ?? {}) as Record<string, unknown>;
  return (clips[String(index)] ?? null) as Record<string, unknown> | null;
}

/** The live `audioRec` projection for lane 0 — phase, slot and the frame maths
 *  the machine latched at arm. `unitFrames` is read from HERE rather than
 *  recomputed in the test: a test that derives the expected loop length from
 *  bpm and step-div is asserting its own arithmetic against itself. */
async function readAudioRec(
  page: Page,
): Promise<{ phase?: string; slot?: number; unitFrames?: number } | null> {
  const d = await readData(page, CP);
  const rec = (d.audioRec ?? {}) as Record<string, unknown>;
  return (rec['0'] ?? null) as { phase?: string; slot?: number; unitFrames?: number } | null;
}

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
  // The SESSION page carries the grid and the per-lane record strip. A railed
  // face renders exactly ONE band, so clicking a chip and reading a cell in the
  // same breath races the swap — `aria-selected` is the state the swap commits.
  const tab = page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="${CP}"]`)
    .getByTestId('faceplate-tab-session');
  await tab.click({ timeout: UI_MS });
  await expect(tab, 'the session page opens').toHaveAttribute('aria-selected', 'true', {
    timeout: STATE_MS,
  });
}

test('ENDLESS mode: tapping record again ends the take at the END of the current loop — a WHOLE multiple, never where the finger landed', async ({
  page,
}) => {
  test.setTimeout(TEST_BUDGET_MS);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.text().includes('[clip-rec]')) console.log(`page: ${msg.text()}`);
  });

  await page.goto('/rack?seed=none', { timeout: BOOT_MS });
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page
    .locator('.svelte-flow__pane:visible')
    .first()
    .waitFor({ state: 'visible', timeout: PANE_MS });
  await spawnPatch(
    page,
    [
      { id: TL, type: 'timelorde', position: { x: 0, y: 0 }, params: { running: 1, bpm: 120 } },
      { id: OSC, type: 'analogVco', position: { x: 0, y: 200 } },
      { id: MIX, type: 'mixmstrs', position: { x: 400, y: 0 } },
      { id: CP, type: 'clipplayer', position: { x: 400, y: 600 } },
      { id: SC, type: 'scope', position: { x: 900, y: 0 } },
    ],
    [
      { id: 'e1', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1L' } },
      { id: 'e2', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1R' } },
      { id: 'e3', from: { nodeId: CP, portId: 'audio1L' }, to: { nodeId: SC, portId: 'ch1' } },
    ],
  );

  // POSITIVE CONTROL — the source chain is real. A silent rig would make the
  // frame maths below a measurement of nothing.
  await expect
    .poll(() => readChannelLevel(page, 0), {
      message: 'channel 1 must hear the patched oscillator before any take',
      timeout: LIVE_METER_MS,
    })
    .toBeGreaterThan(0.02);

  await openLauncher(page);

  // Aim lane 1 at the target slot, then switch the lane to ENDLESS.
  const targetPad = page.getByTestId(`clipplayer-pad-${TARGET_INDEX}`);
  await targetPad.scrollIntoViewIfNeeded({ timeout: UI_MS });
  await targetPad.click({ timeout: UI_MS });

  const recMode = page.getByTestId('clipplayer-rec-mode-0');
  await expect(recMode).toBeVisible({ timeout: UI_MS });
  await expect(recMode, 'CLIP is the default — the bounded mode').toHaveAttribute(
    'data-rec-mode',
    'single',
    { timeout: STATE_MS },
  );
  await recMode.click({ timeout: UI_MS });
  await expect(recMode).toHaveAttribute('data-rec-mode', 'endless', { timeout: STATE_MS });

  // ── ARM ─────────────────────────────────────────────────────────────────
  const recArm = page.getByTestId('clipplayer-rec-arm-0');
  await recArm.click({ timeout: UI_MS });

  await expect
    .poll(async () => (await readAudioRec(page))?.phase ?? null, {
      message: 'the endless take must arm',
      timeout: PROJECT_MS,
    })
    .toBe('recording');

  const armed = await readAudioRec(page);
  const unitFrames = armed?.unitFrames ?? 0;
  expect(unitFrames, 'the machine latched a real loop length at arm').toBeGreaterThan(0);
  expect(armed?.slot, 'and it targeted the selected slot').toBe(TARGET_SLOT);

  // ── RUN PAST A LOOP BOUNDARY, then tap the button MID-LOOP ───────────────
  // ⚠ THE STOP MUST LAND AWKWARDLY OR THE TEST PROVES NOTHING. The whole claim
  // is that the take ends at a loop boundary rather than where the finger fell,
  // so the finger has to fall somewhere that is NOT a boundary. Waiting for the
  // take to pass one whole loop and then some is what guarantees that.
  //
  // The wait is on OBSERVABLE STATE, never a bare sleep: it polls the recorder's
  // own captured-frame progress until it is comfortably past one unit.
  // ⚠ THE LOOP LENGTH IS DERIVED THE WAY THE PRODUCT DERIVES IT, not guessed.
  // With nothing else playing, `#beginPrepare` latches
  // `lengthSteps = DEFAULT_CLIP_STEPS (16)` and a unit of `16 × baseStepDur`
  // seconds — so reading `baseStepDur` off the launcher's own `recClock` and
  // multiplying gives exactly the loop the machine armed against, with no
  // hard-coded bpm or sample rate to drift.
  const loopSeconds = await page.evaluate(
    ([cpId]) => {
      const w = window as unknown as {
        __engine?: () => { read(node: unknown, key: string): unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const cp = w.__patch.nodes[cpId as string];
      if (!eng || !cp) return 0;
      const clock = eng.read(cp, 'recClock') as { baseStepDur?: number } | undefined;
      return (clock?.baseStepDur ?? 0) * 16;
    },
    [CP] as const,
  );
  expect(loopSeconds, 'the launcher reports a real loop length').toBeGreaterThan(0.1);

  // ⚠ THE STOP MUST LAND AWKWARDLY OR THE TEST PROVES NOTHING. The whole claim
  // is that the take ends at a loop boundary rather than where the finger fell,
  // so the finger has to fall somewhere that is NOT a boundary.
  //
  // The wait is measured on the AUDIO PATH rather than slept: each
  // `readScopePeakOverWindow` call polls the live scope and reports the real
  // time it spent doing so, so accumulating its `elapsed` is a clock driven by
  // the same graph the recorder is running on.
  const targetSeconds = loopSeconds * 1.35;
  let elapsedS = 0;
  while (elapsedS < targetSeconds) {
    const w = await readScopePeakOverWindow(page, SC, 400, { minMs: 250 });
    elapsedS += (w.elapsedMs ?? 400) / 1000;
  }
  expect(
    elapsedS / loopSeconds,
    'the endless take must have run PAST one whole loop before the stop gesture',
  ).toBeGreaterThan(1.2);
  // …and it is still recording, so the tap below is a genuine mid-take stop.
  expect((await readAudioRec(page))?.phase, 'the take is still open when tapped').toBe('recording');

  // TAP THE RECORD BUTTON AGAIN — the owner's second stop gesture.
  await recArm.click({ timeout: UI_MS });

  // ── THE ASSERTION — a WHOLE multiple of the loop ─────────────────────────
  // ⚠ POLL FOR `kind === 'audio'`, NEVER FOR "a clip exists". Clicking the pad
  // to aim the record button leaves an EMPTY note placeholder in the slot, which
  // satisfies "not null" immediately — a presence poll here would pass before
  // anything committed and fail one line later on the kind.
  await expect
    .poll(async () => (await readClipAt(page, TARGET_INDEX))?.kind ?? null, {
      message:
        'the endless take must COMMIT — a cancel-then-commit contract loses it to the recovery pile',
      timeout: COMMIT_MS,
    })
    .toBe('audio');

  const rec = (await readClipAt(page, TARGET_INDEX))!;
  const frames = rec.frames as number;
  expect(rec.kind).toBe('audio');
  expect(typeof frames, 'the take reports a frame count').toBe('number');

  const loops = frames / unitFrames;
  expect(
    Number.isInteger(loops),
    `THE WHOLE-LOOP PROPERTY: ${frames} frames is ${loops.toFixed(4)} × the ${unitFrames}-frame loop — ` +
      'an endless take must end at a loop boundary, never where the gesture landed',
  ).toBe(true);
  expect(loops, 'and it kept the whole loops it had already captured').toBeGreaterThanOrEqual(1);

  // ⚠ THE NEGATIVE CONTROL, and it is the half that makes the assertion mean
  // something. An implementation that stopped IMMEDIATELY would commit the
  // fractional length the gesture fell on — which is > 1.35 loops by
  // construction above, and therefore NOT an integer. Asserting only
  // "integer multiple" could be satisfied by a stop that happened to land on a
  // boundary; asserting the fractional take is absent cannot.
  expect(
    loops,
    'an immediate-stop implementation would have committed the fractional length the tap fell on',
  ).not.toBeCloseTo(1.35, 1);

  // ── AND THE TAKE IS AUDIBLE ─────────────────────────────────────────────
  // Presence is not liveness: a whole-loop frame count on a silent file is
  // still a lost take.
  const heard = await (async () => {
    for (let i = 0; i < 6; i++) {
      const w = await readScopePeakOverWindow(page, SC, AUDIBLE_MS / 6, { minMs: 600 });
      if (w.rms > 0.02) return w;
    }
    return await readScopePeakOverWindow(page, SC, AUDIBLE_MS / 6, { minMs: 600 });
  })();
  expect(
    heard.rms,
    `the committed endless take must be AUDIBLE on audio1L: ${describeScopeWindow(heard)}`,
  ).toBeGreaterThan(0.02);

  expect(pageErrors, 'the page threw during the journey').toEqual([]);
});
