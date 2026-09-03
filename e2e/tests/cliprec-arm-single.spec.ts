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
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

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
      timeout: 15_000,
    })
    .toBeLessThan(0.02);
  const confirm = await readScopePeakOverWindow(page, SC, 1200, { minMs: 800 });
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
  // Recording alone is a 2 s musical loop; the journey has seven legs.
  test.setTimeout(180_000);

  // The registry's refusals go to the console with a [clip-rec] prefix; a
  // refusal is a legible failure, so surface it in the test log.
  page.on('console', (msg) => {
    if (msg.text().includes('[clip-rec]')) console.log(`page: ${msg.text()}`);
  });

  // ── The rig: a REAL oscillator into channel 1, the clip output on a scope ──
  // `seed=none` (the test-only empty rack): the workflow pins would add a
  // SECOND mixmstrs/clipplayer pair, and the lane↔channel binding targets the
  // first launcher in the graph — this spec must own which one that is.
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
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
      timeout: 20_000,
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
  await mixShell.getByTestId('shell-open-dock').click();
  const dock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${MIX}"]`);
  await expect(dock).toBeVisible();
  const armCell = dock.getByTestId('control-ch1_rec');
  await armCell.scrollIntoViewIfNeeded();
  await armCell.getByRole('radio', { name: 'once', exact: true }).click();
  // The gesture landed as a real param write (the same origin-tagged seam MIDI
  // and automation use) — this is the surface the registry polls.
  await expect
    .poll(() => readParamValue(page, MIX, 'ch1_rec'), {
      message: "clicking 'once' must land 1 in node.params.ch1_rec",
      timeout: 10_000,
    })
    .toBe(1);

  // The projection walks armed → recording (the pads' shared vocabulary reads
  // exactly this state — rec-armed / rec-active are pure functions of it).
  await expect
    .poll(
      async () => {
        const d = await readData(page, CP);
        const rec = (d.audioRec as Record<string, { phase?: string }> | undefined)?.['0'];
        return rec?.phase ?? null;
      },
      { message: 'the arm must reach audioRec and punch in', timeout: 15_000 },
    )
    .toBe('recording');
  const during = await readData(page, CP);
  const armed = (during.audioRec as Record<string, { unitFrames: number; slot: number }>)['0']!;
  expect(armed.slot).toBe(0); // the lane's first empty slot

  // ── Leg 3 — the commit: one loop, EXACTLY unitFrames, bytes to match ────
  await expect
    .poll(
      async () => {
        const d = await readData(page, CP);
        const clip = (d.clips as Record<string, { kind?: string }> | undefined)?.['0'];
        return clip?.kind ?? null;
      },
      { message: 'the take must commit an audio clip into slot 0', timeout: 30_000 },
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
  expect(clip.frames).toBe(armed.unitFrames); // == the window the arm resolved
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
    .poll(() => readParamValue(page, MIX, 'ch1_rec'), { timeout: 10_000 })
    .toBe(0);

  // ── Leg 4 — the take TAKES OVER: audible, and the MON duck engages ──────
  // "Record a loop and hear it take over" needs no second gesture: the commit
  // queues its own immediate launch.
  await expect
    .poll(
      async () => (await readData(page, CP)).playing as (number | null)[] | undefined,
      { message: 'the committed take auto-launches in its lane', timeout: 15_000 },
    )
    .toEqual(expect.arrayContaining([0]));
  const playing = await readScopePeakOverWindow(page, SC, 8000, {
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
      timeout: 10_000,
    })
    .toBe(0);
  expect((await readRecDuck(page))?.lanePlaying?.[0]).toBe(true);

  // ── Leg 5 — stop: silent again, duck RESTORED ───────────────────────────
  await writeLaneQueue(page, 0, 'stop');
  await expect
    .poll(async () => ((await readData(page, CP)).playing as (number | null)[])?.[0] ?? null, {
      timeout: 10_000,
    })
    .toBe(null);
  await expect
    .poll(async () => (await readRecDuck(page))?.applied?.[0], {
      message: 'stopping the lane must restore the live branch',
      timeout: 10_000,
    })
    .toBe(1);
  // The stop lands on the audio clock a tick after the data flips.
  await expectSilence(page, 'after stop');

  // ── Leg 6 — the explicit LAUNCH leg: the recorded clip fires on demand ──
  await writeLaneQueue(page, 0, 0);
  const relaunched = await readScopePeakOverWindow(page, SC, 8000, {
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
  await page.getByTestId('faceplate-close').click();
  await expect(page.getByTestId('dock-full-view')).toBeHidden();
  const cpShell = page.locator(`.svelte-flow__node[data-id="${CP}"] [data-testid="module-shell"]`);
  await expect(cpShell).toBeVisible();
  await cpShell.getByTestId('shell-open-dock').click();
  const cpDock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${CP}"]`);
  await expect(cpDock).toBeVisible();
  const undoBtn = cpDock.getByTestId(`clipplayer-strip-6-${CP}`);
  await undoBtn.scrollIntoViewIfNeeded();
  await expect(undoBtn).toBeEnabled();
  await undoBtn.click();
  // (a) the clip record is gone…
  await expect
    .poll(
      async () => ((await readData(page, CP)).clips as Record<string, unknown> | undefined)?.['0'] ?? null,
      { message: 'undo must remove the committed clip record', timeout: 10_000 },
    )
    .toBe(null);
  // …(b) and the media is ORPHANED: the graph-pass GC frees the bytes.
  await expect
    .poll(async () => (await mediaFileState(page, mediaId)).present, {
      message: 'the orphaned take must be garbage-collected from OPFS',
      timeout: 20_000,
    })
    .toBe(false);
  // A source must not keep looping a clip that no longer exists.
  await expectSilence(page, 'after undo');
});
