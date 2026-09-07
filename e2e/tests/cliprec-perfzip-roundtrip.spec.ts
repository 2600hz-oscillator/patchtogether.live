// cliprec-perfzip-roundtrip.spec.ts
//
// RECORDED CLIP AUDIO SURVIVES THE PERFORMANCE .ZIP — fleet-audit 2026-09-06
// #2, the feature gate. Clip take bytes live only in origin-local OPFS
// (`clip-media-store`), and before this fix NO save format carried them: the
// perf-zip collector gathered only video + twotracks tapes, so a .ptperf.zip
// loaded anywhere without the original OPFS contents came back with every
// recorded clip SILENT, and nothing anywhere said so.
//
// ⚠ THE PROOF IS AUDIBILITY IN A CONTEXT THAT CANNOT CHEAT. The decode cache
// (`clip-audio-cache`) holds the take in MEMORY after the recording session,
// so a same-page "wipe OPFS → load → audible" leg would pass with a zip that
// carried nothing — green fed entirely by the cache. The journey therefore
// RELOADS the page (fresh JS = empty cache) AND wipes the OPFS clipmedia
// directory before loading, so the loaded zip is the only possible source of
// the bytes the scope then hears.
//
// The journey:
//   1. Record a real take through the real surface (osc → mixmstrs ch1 →
//      lane-1 record button on the launcher face) — same rig the cliprec
//      clip-mode journey pins down.
//   2. Export the performance .zip; assert it is at least the take's size
//      (the media must ride as bytes, not as a mediaId string).
//   3. RELOAD + wipe OPFS clipmedia (the negative control: the take's bytes
//      now exist nowhere in the browser).
//   4. Load the zip. Assert the OPFS bytes are RESTORED, then launch the pad
//      and assert the take is AUDIBLE on the clip's own output (RMS on a
//      scope) — presence is not liveness.
//   5. The missing-media notices: wipe OPFS once more and export (the save
//      side says the take could not ride), then load that hollow zip (the
//      load side says the take will play silence). A swallowed silent
//      failure is itself a bug.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, MOUNT_CAP_MS } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

// ---------------------------------------------------------------------------
// THE BUDGET IS DERIVED FROM THE STEPS, NOT TYPED OVER THEM (see
// cliprec-clip-mode.spec.ts for why a flat wall smaller than its steps' sum
// fails with a bare "Test timeout exceeded" and nothing to grep).
// ---------------------------------------------------------------------------

/** Cold boot: navigation + topbar. Charged for BOTH page loads. */
const BOOT_MS = 30_000;
/** The flow pane painting after the topbar. */
const PANE_MS = 15_000;
/** The live channel meter hearing the oscillator (source positive control). */
const LIVE_METER_MS = 20_000;
/** The arm reaching `audioRec` once the transport plays. */
const PROJECT_MS = 25_000;
/** One musical loop, the OPFS drain, the commit. */
const COMMIT_MS = 40_000;
/** A store value flips (toggle write, playing slot, pad attribute). */
const STATE_MS = 10_000;
/** One scope observation window. */
const AUDIBLE_MS = 8_000;
/** Building/loading the perf zip (IDB + OPFS + reconcile inside). */
const ZIP_MS = 20_000;
/** A single UI gesture. */
const UI_MS = 5_000;

const TEST_BUDGET_MS =
  2 * (2 * BOOT_MS + PANE_MS) +
  MOUNT_CAP_MS +
  LIVE_METER_MS +
  PROJECT_MS +
  COMMIT_MS +
  6 * STATE_MS +
  2 * AUDIBLE_MS +
  4 * ZIP_MS +
  12 * UI_MS;

const TL = 'tl1';
const OSC = 'osc1';
const MIX = 'mx1';
const CP = 'cp1';
const SC = 'sc1';

/** Slot 2, lane 0 — off the default selection so the take landing there means
 *  the selection was honoured (cliprec-clip-mode owns that clause; here it
 *  just keeps the journeys from aliasing). */
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

/** Open the launcher's DOCK faceplate on its SESSION page (grid + rec strip). */
async function openLauncher(page: Page): Promise<void> {
  const shell = page.locator(`.svelte-flow__node[data-id="${CP}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: MOUNT_CAP_MS });
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

/** The size of the take's OPFS file, or null when the file does not exist. */
async function opfsTakeSize(page: Page, mediaId: string): Promise<number | null> {
  return await page.evaluate(async (id) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('clipmedia', { create: false });
      const fh = await dir.getFileHandle(id as string, { create: false });
      return (await fh.getFile()).size;
    } catch {
      return null;
    }
  }, mediaId);
}

/** Delete the whole OPFS clipmedia directory — the take's bytes are then
 *  nowhere in the browser (the decode cache is handled by the page RELOAD). */
async function wipeOpfsClipMedia(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('clipmedia', { recursive: true });
    } catch {
      /* already absent */
    }
  });
}

async function nodeCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, unknown> } };
    return Object.keys(w.__patch.nodes).length;
  });
}

async function exportZipB64(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const w = globalThis as unknown as { __perfZip: { export: () => Promise<Uint8Array> } };
    const bytes = await w.__perfZip.export();
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(bin);
  });
}

async function loadZipB64(page: Page, b64: string): Promise<void> {
  await page.evaluate(async (data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const w = globalThis as unknown as { __perfZip: { load: (b: Uint8Array) => Promise<void> } };
    await w.__perfZip.load(bytes);
  }, b64);
}

async function bootEmptyRack(page: Page): Promise<void> {
  await page.goto('/rack?seed=none', { timeout: BOOT_MS });
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page
    .locator('.svelte-flow__pane:visible')
    .first()
    .waitFor({ state: 'visible', timeout: PANE_MS });
}

test('a recorded clip survives export → fresh context + wiped OPFS → load, AUDIBLY — and a missing take is SAID, not swallowed', async ({
  page,
}) => {
  test.setTimeout(TEST_BUDGET_MS);

  // ⚠ pageerror guard — an effect-tick throw does not fail a Playwright test.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // ── 1 · The rig + a real take through the real surface ───────────────────
  await bootEmptyRack(page);
  await spawnPatch(
    page,
    [
      { id: TL, type: 'timelorde', position: { x: 0, y: 0 }, params: { running: 0, bpm: 120 } },
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

  // POSITIVE control: the live chain is real before anything records.
  await expect
    .poll(() => readChannelLevel(page, 0), {
      message: 'channel 1 must hear the patched oscillator before any take',
      timeout: LIVE_METER_MS,
    })
    .toBeGreaterThan(0.02);

  await openLauncher(page);
  const targetPad = page.getByTestId(`clipplayer-pad-${TARGET_INDEX}`);
  await targetPad.scrollIntoViewIfNeeded({ timeout: UI_MS });
  await targetPad.click({ timeout: UI_MS });
  const recArm = page.getByTestId('clipplayer-rec-arm-0');
  await recArm.click({ timeout: UI_MS });
  await expect(recArm).toHaveAttribute('aria-pressed', 'true', { timeout: STATE_MS });
  await setTransport(page, true);
  await expect
    .poll(
      async () => {
        const d = await readData(page, CP);
        const rec = (d.audioRec ?? {}) as Record<string, { slot?: number } | null>;
        return rec['0']?.slot ?? null;
      },
      { message: 'the take must arm against the selected slot', timeout: PROJECT_MS },
    )
    .toBe(TARGET_SLOT);
  await expect
    .poll(async () => (await readClipAt(page, TARGET_INDEX))?.kind ?? null, {
      message: 'the AUDIO take must commit into the selected slot',
      timeout: COMMIT_MS,
    })
    .toBe('audio');
  const rec = (await readClipAt(page, TARGET_INDEX))!;
  const mediaId = rec.mediaId as string;
  const takeBytes = (rec.frames as number) * 8; // stereo f32
  expect(typeof mediaId, 'the take names OPFS media').toBe('string');
  expect(takeBytes, 'the take has real length').toBeGreaterThan(0);
  await setTransport(page, false);

  // ── 2 · Export: the zip must CARRY the take, not just name it ────────────
  const zipB64 = await exportZipB64(page);
  // Media rides STOREd (level 0), so the archive is at least the take's raw
  // size — a mediaId-only envelope is a few KB and fails here immediately.
  expect(
    zipB64.length,
    'the .zip must carry the take BYTES (≥ frames × 8, base64-expanded)',
  ).toBeGreaterThan(takeBytes);

  // ── 3 · Fresh context + wiped OPFS: the bytes exist NOWHERE ──────────────
  // The reload empties the in-memory decode cache — without it, a zip that
  // carried nothing still plays from cache and this whole spec is vacuous.
  await bootEmptyRack(page);
  expect(await nodeCount(page), 'the fresh scratch rack is empty (no replica under webdriver)').toBe(0);
  await wipeOpfsClipMedia(page);
  expect(await opfsTakeSize(page, mediaId), 'NEGATIVE CONTROL: the take is gone from OPFS').toBeNull();

  // ── 4 · Load the zip: bytes restored, pad launches, take AUDIBLE ─────────
  await loadZipB64(page, zipB64);
  await expect.poll(() => nodeCount(page), { timeout: ZIP_MS }).toBe(5);
  await expect
    .poll(() => opfsTakeSize(page, mediaId), {
      message: 'the take bytes must be restored into the OPFS media store',
      timeout: ZIP_MS,
    })
    .toBe(takeBytes);
  const restored = await readClipAt(page, TARGET_INDEX);
  expect(restored?.kind, 'the clip record rode the envelope').toBe('audio');
  expect(restored?.mediaId, 'and still names the same media').toBe(mediaId);

  await setTransport(page, true);
  await openLauncher(page);
  const padAfter = page.getByTestId(`clipplayer-pad-${TARGET_INDEX}`);
  await padAfter.scrollIntoViewIfNeeded({ timeout: UI_MS });
  await padAfter.click({ timeout: UI_MS });
  // Assert the LAUNCH before measuring audio, so a silent failure names which
  // half broke (never launched vs launched-and-silent).
  await expect
    .poll(async () => ((await readData(page, CP)).playing as (number | null)[])?.[0] ?? null, {
      message: 'the pad click must launch the restored clip',
      timeout: STATE_MS,
    })
    .toBe(TARGET_SLOT);
  const heard = await readScopePeakOverWindow(page, SC, AUDIBLE_MS, {
    untilRms: 0.02,
    minMs: 600,
  });
  expect(
    heard.rms,
    `THE RESTORED TAKE MUST BE AUDIBLE on clipplayer audio1L: ${describeScopeWindow(heard)}`,
  ).toBeGreaterThan(0.02);

  // ── 5 · The MISSING-MEDIA notices (both sides of the seam) ───────────────
  await setTransport(page, false);
  await wipeOpfsClipMedia(page);
  // SAVE side: exporting a rack whose take has no local bytes says so.
  const hollowB64 = await exportZipB64(page);
  await expect(
    page.getByTestId('load-error'),
    'the export must SAY a take could not ride the bundle',
  ).toContainText('could not ride the bundle', { timeout: STATE_MS });
  // The hollow zip is far smaller than the take — nothing rode.
  expect(hollowB64.length, 'the hollow zip carries no take bytes').toBeLessThan(takeBytes);
  // LOAD side: loading that hollow zip says the take will play silence.
  await loadZipB64(page, hollowB64);
  await expect.poll(() => nodeCount(page), { timeout: ZIP_MS }).toBe(5);
  await expect(
    page.getByTestId('load-error'),
    'the load must SAY the take has no audio on this machine',
  ).toContainText('no audio in this browser', { timeout: STATE_MS });

  expect(pageErrors, 'the page threw during the journey').toEqual([]);
});
