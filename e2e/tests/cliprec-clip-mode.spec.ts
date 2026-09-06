// cliprec-clip-mode.spec.ts
//
// PER-CLIP AUDIO RECORDING, END TO END, THROUGH THE REAL SURFACE — the owner's
// 2026-09-04 redesign. A real oscillator into mixmstrs channel 1, recorded into
// the SELECTED clip of launcher lane 1 by the lane's own record button on the
// launcher face, then PLAYED — with the pass/fail line being AUDIBLE RMS on the
// clip's own output (`clipplayer.audio1L` → SCOPE).
//
// ⚠ PRESENCE IS NOT LIVENESS. Per the standing rule, driving the engine class
// directly or asserting that a file appeared does not count: a green run that
// never actually recorded looks identical to one that did unless the recorded
// take itself makes noise. Every claim below is receiver-side.
//
// The clauses this journey covers, in order, each with a control:
//   1/3 · the record control is a per-lane TOGGLE on the launcher view itself;
//   2   · the take lands in the SELECTED clip of that lane — not "the first
//         empty slot", which is what the old mixer-armed design did;
//   4   · the toggle is set while the transport is STOPPED and nothing records;
//         recording starts when it PLAYS;
//   5   · CLIP mode records EXACTLY ONE LOOP (frames == unitFrames exactly);
//   7   · the pad holding the take paints its PURPLE BORDER, and keeps it while
//         the clip is playing;
//   6   · flipping that clip to LIVE silences its recorded playback — the
//         per-clip replacement for the removed channel-level MON duck.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, MOUNT_CAP_MS } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

// ---------------------------------------------------------------------------
// THE BUDGET IS DERIVED FROM THE STEPS, NOT TYPED OVER THEM
//
// ⚠ A flat wall SMALLER than the sum of the caps it contains cannot fail at the
// step that was slow: every step stays inside its own cap, the aggregate runs
// out, and Playwright reports a bare "Test timeout of N exceeded" against
// whatever call was in flight — no assertion text, nothing to grep but its
// absence. So the caps are named ONCE and the wall is their SUM.
// ---------------------------------------------------------------------------

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
  2 * AUDIBLE_MS +
  2 * SILENCE_MS +
  10 * UI_MS;

const TL = 'tl1';
const OSC = 'osc1';
const MIX = 'mx1';
const CP = 'cp1';
const SC = 'sc1';

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

test('CLIP mode: armed while stopped, records ONE loop into the SELECTED clip on play, and the take is AUDIBLE, purple-bordered and LIVE-switchable', async ({
  page,
}) => {
  test.setTimeout(TEST_BUDGET_MS);

  // ⚠ A pageerror guard belongs in every spec of this shape: an uncaught
  // exception inside an effect tick does NOT fail a Playwright test on its own,
  // and a recorder that threw once per tick would look like one that idled.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.text().includes('[clip-rec]')) console.log(`page: ${msg.text()}`);
  });

  // ── The rig ─────────────────────────────────────────────────────────────
  // `seed=none` (the test-only empty rack): the workflow pins would add a
  // SECOND mixmstrs/clipplayer pair, and the lane↔channel binding targets the
  // first launcher in the graph — this spec must own which one that is.
  await page.goto('/rack?seed=none', { timeout: BOOT_MS });
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page
    .locator('.svelte-flow__pane:visible')
    .first()
    .waitFor({ state: 'visible', timeout: PANE_MS });
  await spawnPatch(
    page,
    [
      // ⚠ STOPPED AT SPAWN. Clause 4's whole subject is a toggle set while the
      // transport is not running, so the rack must start that way.
      { id: TL, type: 'timelorde', position: { x: 0, y: 0 }, params: { running: 0, bpm: 120 } },
      { id: OSC, type: 'analogVco', position: { x: 0, y: 200 } },
      { id: MIX, type: 'mixmstrs', position: { x: 400, y: 0 } },
      { id: CP, type: 'clipplayer', position: { x: 400, y: 600 } },
      { id: SC, type: 'scope', position: { x: 900, y: 0 } },
    ],
    [
      // The dual-mono double-patch: the mono sine into BOTH legs of channel 1.
      { id: 'e1', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1L' } },
      { id: 'e2', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1R' } },
      // THE ASSERTION SUBJECT: the clip's own lane output.
      { id: 'e3', from: { nodeId: CP, portId: 'audio1L' }, to: { nodeId: SC, portId: 'ch1' } },
    ],
  );

  // ── Controls before anything records ────────────────────────────────────
  // POSITIVE: the live chain is real — channel 1's meter hears the oscillator.
  // Without this every silence below is satisfied by a rack that never made a
  // sound in the first place.
  await expect
    .poll(() => readChannelLevel(page, 0), {
      message: 'channel 1 must hear the patched oscillator before any take',
      timeout: LIVE_METER_MS,
    })
    .toBeGreaterThan(0.02);
  // NEGATIVE: the clip output is silent — nothing has ever been recorded.
  const before = await readScopePeakOverWindow(page, SC, 1200);
  expect(before.peak, `clip output before any take: ${describeScopeWindow(before)}`).toBeLessThan(
    0.02,
  );

  await openLauncher(page);

  // ── CLAUSE 2 — aim lane 1's record button at slot 4 by CLICKING that pad ──
  // A plain click selects the lane's record target. Slot 3 is chosen precisely
  // because the retired "first empty slot" behaviour would have picked slot 0.
  const targetPad = page.getByTestId(`clipplayer-pad-${TARGET_INDEX}`);
  await targetPad.scrollIntoViewIfNeeded({ timeout: UI_MS });
  await targetPad.click({ timeout: UI_MS });

  // ── CLAUSES 3 + 4 — toggle record ON while the transport is STOPPED ──────
  const recArm = page.getByTestId('clipplayer-rec-arm-0');
  await expect(recArm, 'the record toggle is on the LAUNCHER view, not behind a tab').toBeVisible({
    timeout: UI_MS,
  });
  await recArm.click({ timeout: UI_MS });
  await expect(recArm).toHaveAttribute('aria-pressed', 'true', { timeout: STATE_MS });

  // NOTHING RECORDS WHILE STOPPED, and the toggle SURVIVES. The second half is
  // the load-bearing one: the pre-redesign registry tore a pending arm down on
  // every stopped tick, which is exactly why arm-while-stopped was impossible.
  const stoppedSoak = await readScopePeakOverWindow(page, SC, 1200);
  expect(
    stoppedSoak.peak,
    `nothing may sound while stopped: ${describeScopeWindow(stoppedSoak)}`,
  ).toBeLessThan(0.02);
  // ⚠ NOT `toBeNull()`. Clicking an empty pad to aim the record button
  // materialises an EMPTY note clip as a placeholder — that is the launcher's
  // existing behaviour, not this feature's. What must be absent is a TAKE.
  expect(
    (await readClipAt(page, TARGET_INDEX))?.kind,
    'no AUDIO take may commit while the transport is stopped',
  ).not.toBe('audio');
  await expect
    .poll(async () => (await readData(page, CP)).recArm as Record<string, boolean> | undefined, {
      message: 'the record toggle must survive a stopped transport',
      timeout: STOPPED_SOAK_MS,
    })
    .toEqual({ '0': true });

  // ── PLAY — this is what starts the recording (clause 4) ─────────────────
  await setTransport(page, true);

  // The arm reaches the pad: `audioRec` projects lane 0 armed/recording at the
  // SELECTED slot — the projection that drives the pad ladder.
  await expect
    .poll(
      async () => {
        const d = await readData(page, CP);
        const rec = (d.audioRec ?? {}) as Record<string, { slot?: number; phase?: string } | null>;
        return rec['0']?.slot ?? null;
      },
      {
        message: 'the take must arm against the SELECTED slot once the transport plays',
        timeout: PROJECT_MS,
      },
    )
    .toBe(TARGET_SLOT);

  // ── CLAUSE 5 (CLIP) — exactly one loop, then it stops itself ────────────
  // ⚠ POLL FOR `kind === 'audio'`, NEVER FOR "a clip exists". The empty note
  // placeholder created by clicking the pad satisfies "not null" the instant it
  // is written, so a presence poll here passes before anything has recorded and
  // then fails one line later on the kind — which is a slow way of asserting
  // nothing at all.
  await expect
    .poll(async () => (await readClipAt(page, TARGET_INDEX))?.kind ?? null, {
      message: 'the AUDIO take must commit into the SELECTED slot',
      timeout: COMMIT_MS,
    })
    .toBe('audio');

  const rec = (await readClipAt(page, TARGET_INDEX))!;
  expect(rec.kind, 'the committed record is an AUDIO clip').toBe('audio');
  expect(typeof rec.mediaId, 'it names OPFS media').toBe('string');
  // ⚠ THE CAPTURED BYTES ARE NON-SILENT, MEASURED IN OPFS. This separates "the
  // pre-board tap heard nothing" from "playback is broken" — two failures that
  // both read 0.0000 on the scope below, and which no single measurement can
  // tell apart. It reads the take's own f32 samples straight out of the media
  // store, so it is the capture side and nothing else.
  const capturedPeak = await page.evaluate(async (mediaId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('clipmedia', { create: false });
    const fh = await dir.getFileHandle(mediaId as string, { create: false });
    const buf = await (await fh.getFile()).arrayBuffer();
    const f32 = new Float32Array(buf);
    let peak = 0;
    for (let i = 0; i < f32.length; i++) {
      const a = Math.abs(f32[i]!);
      if (a > peak) peak = a;
    }
    return { peak, bytes: buf.byteLength };
  }, rec.mediaId as string);
  console.log(`[take] frames=${rec.frames} rate=${rec.sampleRate} opfs=${JSON.stringify(capturedPeak)}`);
  expect(
    capturedPeak.bytes,
    'the take stored exactly frames × 8 bytes (stereo f32)',
  ).toBe((rec.frames as number) * 8);
  expect(
    capturedPeak.peak,
    'THE CAPTURE was silent — the pre-board tap wrote zeros, so playback is not the failure',
  ).toBeGreaterThan(0.02);

  // ⚠ CLAUSE 2, ASSERTED FROM THE OTHER SIDE TOO. A take in the right slot is
  // only half the claim; nothing may have landed in slot 0, which is where the
  // retired first-empty-slot behaviour would have put it.
  expect(
    (await readClipAt(page, 0))?.kind,
    'an audio take landed in slot 1 — the recorder ignored the selection',
  ).not.toBe('audio');

  // The toggle snapped off: CLIP records one loop, then stops.
  await expect(recArm, 'CLIP mode disarms itself after one loop').toHaveAttribute(
    'aria-pressed',
    'false',
    { timeout: STATE_MS },
  );

  // ── CLAUSE 7 — the pad holding recorded audio paints its PURPLE BORDER ───
  await expect(targetPad, 'a clip holding recorded audio is marked on the launcher').toHaveAttribute(
    'data-audio',
    '1',
    { timeout: STATE_MS },
  );
  const purple = await targetPad.evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(purple, 'the border is the purple the owner asked for').toBe('rgb(168, 85, 247)');

  // ── THE PASS/FAIL LINE — the take is AUDIBLE on the clip's own output ────
  // Everything above is metadata; this is the only leg that proves audio was
  // captured at all. The commit queues its own take-over launch, so the clip
  // should sound without another gesture.
  // ⚠ ASSERT THE LAUNCH BEFORE MEASURING THE AUDIO. A silent scope has two very
  // different causes — the clip never launched, or it launched and produced
  // nothing — and one reading of 0.0000 cannot tell them apart. Splitting them
  // means a future failure names which half broke instead of pointing at the
  // instrument.
  await expect
    .poll(async () => ((await readData(page, CP)).playing as (number | null)[])?.[0] ?? null, {
      message: 'the commit must queue its own take-over launch, and the launch must APPLY',
      timeout: STATE_MS,
    })
    .toBe(TARGET_SLOT);

  const heard = await (async () => {
    for (let i = 0; i < 10; i++) {
      const w = await readScopePeakOverWindow(page, SC, AUDIBLE_MS / 5, { minMs: 600 });
      if (w.rms > 0.02) return w;
    }
    return await readScopePeakOverWindow(page, SC, AUDIBLE_MS / 5, { minMs: 600 });
  })();
  expect(
    heard.rms,
    `THE RECORDED TAKE MUST BE AUDIBLE on clipplayer audio1L: ${describeScopeWindow(heard)}`,
  ).toBeGreaterThan(0.02);

  // ⚠ AND THE PURPLE SURVIVES PLAYBACK. This is why clause 7 is an overlay and
  // not a `clipPadState` rung: `playing` outranks `loaded`, so a state-based
  // border would vanish exactly when the clip sounds.
  await expect(targetPad, 'the purple border must survive the clip playing').toHaveAttribute(
    'data-audio',
    '1',
    { timeout: STATE_MS },
  );

  // ── CLAUSE 6 — flip the clip to LIVE and its recorded audio stops ────────
  // The per-clip replacement for the removed channel-level MON duck: the take
  // is still there, it simply does not play, so the lane's live input is what
  // reaches the channel.
  await page.evaluate(
    ([cpId, index]) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const node = w.__patch.nodes[cpId as string]!;
      w.__ydoc.transact(() => {
        const clips = node.data!.clips as Record<string, Record<string, unknown>>;
        clips[String(index)]!.live = true;
      });
    },
    [CP, TARGET_INDEX] as const,
  );
  await expectSilence(page, 'a clip set to LIVE must not play its recorded take');

  // …and the take was NOT destroyed by the flip — LIVE is a playback choice,
  // not a delete. (A clause-6 implementation that dropped the media would pass
  // the silence check above and be catastrophically wrong.)
  const after = await readClipAt(page, TARGET_INDEX);
  expect(after?.kind, 'the take still exists — LIVE is a playback choice').toBe('audio');
  expect(after?.mediaId, 'and still names the same media').toBe(rec.mediaId);
  expect(await targetPad.getAttribute('data-audio'), 'and the pad still says so').toBe('1');

  expect(pageErrors, 'the page threw during the journey').toEqual([]);
});
