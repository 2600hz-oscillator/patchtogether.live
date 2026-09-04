// cliprec-arm-single.spec.ts
//
// Slice 5 — ARM-SINGLE, END TO END, through the REAL chain: a real oscillator
// patched into MIXMSTRS channel 1, armed from the mixer's own record band (the
// face's ch1_rec segmented cell — the real surface, not an engine call), one
// loop recorded through the clip-recorder worklet into OPFS, committed as an
// AudioClipRecord, and PLAYED — with the pass/fail line being AUDIBLE RMS on
// the clip's own output (`clipplayer.audio1L` → SCOPE). Per the standing
// poly/MIDI-source rule, driving the engine class directly or asserting that a
// file appeared does not count; a green run that never actually recorded looks
// identical to one that did unless the recorded take itself makes noise.
//
// The one journey covers, in order, with a control at every leg:
//   1. the live chain is audible at the mixer BEFORE any recording exists
//      (positive control: the source chain is real) while the clip output is
//      SILENT (negative control: nothing plays what was never recorded);
//   2. arm via the face → audioRec projects armed → recording;
//   3. the commit: clips[k] holds kind:'audio' with frames == unitFrames
//      EXACTLY (the slice-4 maths verified end-to-end) and the OPFS file holds
//      exactly frames × 8 bytes; the arm knob snaps back to off;
//   4. the take TAKES OVER (auto-launch) → audible RMS on audio1L, and the
//      MON clip-auto duck ENGAGES (live branch gain 0) while the lane plays;
//   5. stopping the lane silences the clip output and RESTORES the duck;
//   6. an explicit re-LAUNCH sounds again (the launched leg, demanded by the
//      slice row);
//   7. UNDO (the launcher's own scoped undo, the stack the commit landed on)
//      removes the clip record AND orphans the media — the graph-pass GC
//      frees the OPFS bytes, and the still-looping source is cut.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, MOUNT_CAP_MS } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

// ---------------------------------------------------------------------------
// THE BUDGET IS DERIVED FROM THE STEPS, NOT TYPED OVER THEM
//
// ⚠ A flat wall SMALLER than the sum of the caps it contains cannot fail at
// the step that was slow. Every step stays inside its own cap, the aggregate
// runs out, and Playwright reports a bare "Test timeout of N exceeded" against
// whatever call happened to be in flight — no assertion text, nothing to grep
// but its absence. This spec shipped with `test.setTimeout(180_000)` over caps
// summing to well over 300 s; it never fired (leg 3 failed cleanly at its own
// 30 s cap), which is the only reason the ARM-SINGLE product bug it caught was
// legible at all. That was luck, and luck is not a property.
//
// Note what this is NOT: no wait here got longer, no window widened, no settle
// added. The wall is a LAST RESORT that should never be the thing that fires —
// so it is sized to be the last resort, and it costs wall-clock only on a run
// that is already failing. If the total looks large, the honest lever is
// trimming a leg's cap or splitting the seven legs, not re-flattening the wall
// back under them.
//
// So the caps are named ONCE, here, and the wall is their SUM: the same
// numbers, added up instead of guessed at. Raising a leg's cap raises the wall
// with it, and the wall can never sit under its own steps again.
// ---------------------------------------------------------------------------

/** Cold boot: the navigation, then the topbar painting. Charged TWICE below
 *  because the goto now carries the cap too — see the goto's own note. */
const BOOT_MS = 30_000;
/** The flow pane painting after the topbar — the last boot step. Its own cap
 *  because it follows a 30 s boot wait and a UI-gesture cap would be tight. */
const PANE_MS = 15_000;
/** Leg 1's positive control: the live channel meter hearing the oscillator. */
const LIVE_METER_MS = 20_000;
/** Leg 2: the arm edge reaching `audioRec` (prepare → open media → confirm). */
const PROJECT_MS = 20_000;
/** Leg 3: 2 s of music, then the OPFS drain, the commit and the undo unit. */
const COMMIT_MS = 30_000;
/** Leg 4: the commit queueing its own immediate launch. */
const LAUNCH_MS = 15_000;
/** Leg 7: the graph-pass GC freeing the orphaned OPFS bytes. */
const GC_MS = 20_000;
/** A store value flips: a param write, a duck gain, a lane's playing slot. */
const STATE_MS = 10_000;
/** One scope observation window (`readScopePeakOverWindow`), legs 4 and 6. */
const AUDIBLE_MS = 8_000;
/** `expectSilence`: the settle poll, then the confirming window. */
const SILENCE_POLL_MS = 15_000;
const SILENCE_CONFIRM_MS = 1_200;
const SILENCE_MS = SILENCE_POLL_MS + SILENCE_CONFIRM_MS;
/** A single UI gesture — a click, a scroll-into-view, a visibility wait. The
 *  clicks below carry it EXPLICITLY: Playwright's `actionTimeout` is unset in
 *  this suite's config, so an unbounded click eats the whole wall and blames
 *  the next line. Visibility waits are already capped here by expect's own
 *  default, which this equals. */
const UI_MS = 5_000;

/** The wall: every cap this test contains, added up. The multipliers are the
 *  number of times each cap appears in the body below — grep them and count. */
const TEST_BUDGET_MS =
  2 * BOOT_MS + // the goto, then the topbar
  PANE_MS +
  MOUNT_CAP_MS + // spawnPatch's own mount cap, imported not retyped
  LIVE_METER_MS +
  PROJECT_MS +
  COMMIT_MS +
  LAUNCH_MS +
  GC_MS +
  6 * STATE_MS +
  2 * AUDIBLE_MS +
  2 * SILENCE_MS +
  SILENCE_CONFIRM_MS + // leg 1's negative-control window, the same 1200 ms shape
  13 * UI_MS;

const TL = 'tl1';
const OSC = 'osc1';
const MIX = 'mx1';
const CP = 'cp1';
const SC = 'sc1';

/** Node data, deep-copied out of the live graph. */
async function readData(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, { data?: unknown }> } };
    return JSON.parse(JSON.stringify(w.__patch.nodes[id]?.data ?? {})) as Record<string, unknown>;
  }, nodeId);
}

async function readParamValue(page: Page, nodeId: string, paramId: string): Promise<number | null> {
  return await page.evaluate(
    ([id, pid]) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> }> };
      };
      const v = w.__patch.nodes[id!]?.params?.[pid!];
      return typeof v === 'number' ? v : null;
    },
    [nodeId, paramId],
  );
}

/** The mixer's live duck observability: per-channel lanePlaying + the applied
 *  live-branch gain (`read('recDuck')` — values the audio thread was handed). */
async function readRecDuck(
  page: Page,
): Promise<{ lanePlaying: boolean[]; applied: number[] } | null> {
  return await page.evaluate((mixId) => {
    const w = window as unknown as {
      __engine?: () => { read(node: unknown, key: string): unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const mix = w.__patch.nodes[mixId];
    if (!eng || !mix) return null;
    return (eng.read(mix, 'recDuck') ?? null) as { lanePlaying: boolean[]; applied: number[] } | null;
  }, MIX);
}

/** Settle-then-confirm silence: poll SHORT windows until one reads quiet
 *  (a single sample can land on a sine's zero-crossing; a long window that
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

/** Transient lane write — the same un-tagged Y.Doc path a pad click takes. */
async function writeLaneQueue(page: Page, lane: number, slot: number | 'stop'): Promise<void> {
  await page.evaluate(
    ([cpId, l, s]) => {
      const w = window as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const node = w.__patch.nodes[cpId as string]!;
      w.__ydoc.transact(() => {
        if (!node.data) node.data = {};
        const queued = new Array(8).fill(null) as (number | string | null)[];
        queued[l as number] = s as number | string;
        node.data.queued = queued;
        const qi = new Array(8).fill(false) as boolean[];
        qi[l as number] = true;
        node.data.queuedImmediate = qi;
      });
    },
    [CP, lane, slot] as const,
  );
}

/** Whether the OPFS clip media file for `mediaId` still exists, and its size. */
async function mediaFileState(
  page: Page,
  mediaId: string,
): Promise<{ present: boolean; size: number }> {
  return await page.evaluate(async (id) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('clipmedia', { create: false });
      const fh = await dir.getFileHandle(id, { create: false });
      const f = await fh.getFile();
      return { present: true, size: f.size };
    } catch {
      return { present: false, size: 0 };
    }
  }, mediaId);
}

test('ARM-SINGLE records one loop from the real chain and the take is AUDIBLE, exact, ducked, launched and undoable', async ({
  page,
}) => {
  // Recording alone is a 2 s musical loop; the journey has seven legs. The
  // wall is the SUM of those legs' own caps — see TEST_BUDGET_MS.
  test.setTimeout(TEST_BUDGET_MS);

  // The registry's refusals go to the console with a [clip-rec] prefix; a
  // refusal is a legible failure, so surface it in the test log.
  page.on('console', (msg) => {
    if (msg.text().includes('[clip-rec]')) console.log(`page: ${msg.text()}`);
  });

  // ── The rig: a REAL oscillator into channel 1, the clip output on a scope ──
  // `seed=none` (the test-only empty rack): the workflow pins would add a
  // SECOND mixmstrs/clipplayer pair, and the lane↔channel binding targets the
  // first launcher in the graph — this spec must own which one that is.
  // The goto carries its own cap: this suite's config sets no
  // `navigationTimeout`, so an unbounded navigation is bounded only by the
  // wall — and a step with no cap of its own is a step that can never be the
  // one blamed.
  await page.goto('/rack?seed=none', { timeout: BOOT_MS });
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible', timeout: PANE_MS });
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
      // The dual-mono double-patch: the mono sine into BOTH legs of channel 1.
      { id: 'e1', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1L' } },
      { id: 'e2', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1R' } },
      // THE ASSERTION SUBJECT: the clip's own lane output.
      { id: 'e3', from: { nodeId: CP, portId: 'audio1L' }, to: { nodeId: SC, portId: 'ch1' } },
    ],
  );

  // ── Leg 1 — controls before anything records ────────────────────────────
  // POSITIVE: the live chain is real — channel 1's post-fader meter hears the
  // oscillator. (A silent rig would make every later "it recorded!" vacuous.)
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

  // ── Leg 2 — arm from the REAL surface: the mixer face's record band ─────
  const mixShell = page.locator(
    `.svelte-flow__node[data-id="${MIX}"] [data-testid="module-shell"]`,
  );
  await expect(mixShell).toBeVisible();
  await mixShell.getByTestId('shell-open-dock').click({ timeout: UI_MS });
  const dock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${MIX}"]`);
  await expect(dock).toBeVisible();
  const armCell = dock.getByTestId('control-ch1_rec');
  await armCell.scrollIntoViewIfNeeded();
  await armCell.getByRole('radio', { name: 'once', exact: true }).click({ timeout: UI_MS });
  // The gesture landed as a real param write (the same origin-tagged seam MIDI
  // and automation use) — this is the surface the registry polls.
  await expect
    .poll(() => readParamValue(page, MIX, 'ch1_rec'), {
      message: "clicking 'once' must land 1 in node.params.ch1_rec",
      timeout: STATE_MS,
    })
    .toBe(1);

  // The arm projects into audioRec (the pads' shared vocabulary — rec-armed /
  // rec-active are pure functions of it; the armed→recording walk itself is
  // unit-tested). CAPTURE the projection inside the poll: on a slow host the
  // whole 2 s take can pass between two polls, and a separate re-read after
  // the poll would find the projection already cleared by the commit.
  let armed: { unitFrames: number; slot: number } | null = null;
  await expect
    .poll(
      async () => {
        const d = await readData(page, CP);
        const rec = (
          d.audioRec as
            | Record<string, { phase?: string; unitFrames?: number; slot?: number }>
            | undefined
        )?.['0'];
        if (rec && typeof rec.unitFrames === 'number' && rec.unitFrames > 0) {
          armed = { unitFrames: rec.unitFrames, slot: rec.slot ?? -1 };
        }
        return armed ? 'projected' : (rec?.phase ?? null);
      },
      { message: 'the arm must project into audioRec', timeout: PROJECT_MS },
    )
    .toBe('projected');
  expect(armed!.slot).toBe(0); // the lane's first empty slot

  // ── Leg 3 — the commit: one loop, EXACTLY unitFrames, bytes to match ────
  await expect
    .poll(
      async () => {
        const d = await readData(page, CP);
        const clip = (d.clips as Record<string, { kind?: string }> | undefined)?.['0'];
        return clip?.kind ?? null;
      },
      { message: 'the take must commit an audio clip into slot 0', timeout: COMMIT_MS },
    )
    .toBe('audio');
  const after = await readData(page, CP);
  const clip = (after.clips as Record<string, Record<string, unknown>>)['0']!;
  const sr = await page.evaluate(() => {
    const w = window as unknown as {
      __engine?: () => { getDomain(d: string): { ctx: { sampleRate: number } } } | null;
    };
    return w.__engine?.()?.getDomain('audio').ctx.sampleRate ?? 0;
  });
  expect(sr).toBeGreaterThan(0);
  // 120 bpm · stepDiv 1/16 · 16 steps · rate ×1 = exactly two seconds.
  const expectedFrames = Math.round(16 * (60 / 120 / 4) * sr);
  expect(clip.frames, 'the slice-4 frame maths, verified end-to-end').toBe(expectedFrames);
  expect(clip.frames).toBe(armed!.unitFrames); // == the window the arm resolved
  expect(clip.sampleRate).toBe(sr); // the achieved rate, never a requested one
  expect(clip.format).toBe('pcm-f32');
  const mediaId = clip.mediaId as string;
  expect(mediaId).toBeTruthy();
  // The OPFS file holds every byte: frames × 2 ch × 4 B, no more, no less —
  // a dropped chunk or a skipped write cannot produce this number.
  const media = await mediaFileState(page, mediaId);
  expect(media.present).toBe(true);
  expect(media.size, 'interleaved f32 stereo, byte-exact').toBe(expectedFrames * 8);
  // The arm knob snapped back to OFF (a fresh edge is required to re-arm).
  await expect
    .poll(() => readParamValue(page, MIX, 'ch1_rec'), { timeout: STATE_MS })
    .toBe(0);

  // ── Leg 4 — the take TAKES OVER: audible, and the MON duck engages ──────
  // "Record a loop and hear it take over" needs no second gesture: the commit
  // queues its own immediate launch.
  await expect
    .poll(
      async () => (await readData(page, CP)).playing as (number | null)[] | undefined,
      { message: 'the committed take auto-launches in its lane', timeout: LAUNCH_MS },
    )
    .toEqual(expect.arrayContaining([0]));
  const playing = await readScopePeakOverWindow(page, SC, AUDIBLE_MS, {
    untilRms: 0.05,
    minMs: 500,
  });
  expect(
    playing.rms,
    `AUDIBLE RMS on the clip's own output — ${describeScopeWindow(playing)}`,
  ).toBeGreaterThan(0.05);
  // The clip-auto duck consumed the lane-playing flag: the live branch of
  // channel 1 was handed gain 0 AT the launch boundary.
  await expect
    .poll(async () => (await readRecDuck(page))?.applied?.[0], {
      message: 'MON clip-auto must duck the live branch while the lane plays',
      timeout: STATE_MS,
    })
    .toBe(0);
  expect((await readRecDuck(page))?.lanePlaying?.[0]).toBe(true);

  // ── Leg 5 — stop: silent again, duck RESTORED ───────────────────────────
  await writeLaneQueue(page, 0, 'stop');
  await expect
    .poll(async () => ((await readData(page, CP)).playing as (number | null)[])?.[0] ?? null, {
      timeout: STATE_MS,
    })
    .toBe(null);
  await expect
    .poll(async () => (await readRecDuck(page))?.applied?.[0], {
      message: 'stopping the lane must restore the live branch',
      timeout: STATE_MS,
    })
    .toBe(1);
  // The stop lands on the audio clock a tick after the data flips.
  await expectSilence(page, 'after stop');

  // ── Leg 6 — the explicit LAUNCH leg: the recorded clip fires on demand ──
  await writeLaneQueue(page, 0, 0);
  const relaunched = await readScopePeakOverWindow(page, SC, AUDIBLE_MS, {
    untilRms: 0.05,
    minMs: 500,
  });
  expect(
    relaunched.rms,
    `launched again — ${describeScopeWindow(relaunched)}`,
  ).toBeGreaterThan(0.05);

  // ── Leg 7 — UNDO: the record goes, the media is orphaned, the GC frees ──
  // The commit landed on the LAUNCHER's own scoped undo stack (one unit);
  // its face deck carries that stack's ↶. Close the mixer's dock first — the
  // full view overlays the lane tiles and would swallow the click.
  await page.getByTestId('faceplate-close').click({ timeout: UI_MS });
  await expect(page.getByTestId('dock-full-view')).toBeHidden();
  const cpShell = page.locator(`.svelte-flow__node[data-id="${CP}"] [data-testid="module-shell"]`);
  await expect(cpShell).toBeVisible();
  await cpShell.getByTestId('shell-open-dock').click({ timeout: UI_MS });
  const cpDock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${CP}"]`);
  await expect(cpDock).toBeVisible();
  const undoBtn = cpDock.getByTestId(`clipplayer-strip-6-${CP}`);
  await undoBtn.scrollIntoViewIfNeeded();
  await expect(undoBtn).toBeEnabled();
  await undoBtn.click({ timeout: UI_MS });
  // (a) the clip record is gone…
  await expect
    .poll(
      async () => ((await readData(page, CP)).clips as Record<string, unknown> | undefined)?.['0'] ?? null,
      { message: 'undo must remove the committed clip record', timeout: STATE_MS },
    )
    .toBe(null);
  // …(b) and the media is ORPHANED: the graph-pass GC frees the bytes.
  await expect
    .poll(async () => (await mediaFileState(page, mediaId)).present, {
      message: 'the orphaned take must be garbage-collected from OPFS',
      timeout: GC_MS,
    })
    .toBe(false);
  // A source must not keep looping a clip that no longer exists.
  await expectSilence(page, 'after undo');
});
