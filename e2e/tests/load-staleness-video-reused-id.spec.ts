// e2e/tests/load-staleness-video-reused-id.spec.ts
//
// VIDEOBOX + VIDEOVARISPEED KEEP PLAYING THE PREVIOUS PATCH'S CLIP after a
// same-session load at a reused node id — fleet audit 2026-09-06, finding #3.
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────
// `loadEnvelopeIntoStore` deletes and re-inserts every node at its SAME id in
// one transaction. The reconciler keeps the engine node; the node-owned source
// registries keep their controller and <video> element. Patch v2's
// `fileMeta.handleId` therefore arrives as a DOC CHANGE on a controller still
// holding v1's bytes — and the saved-handle reload ran once at creation and
// short-circuited on "has bytes". v1 kept PLAYING while every surface
// reported v2's file. The fix ports the archivist's shape: re-attach on a
// CHANGE of handle id (`node-video-source-registry`, `node-varispeed-registry`).
//
// ── WHAT THIS PROVES ────────────────────────────────────────────────────────
// Two clips are seeded into the app's own IndexedDB handle store under two
// ids — the same blob-handle record the perf-zip loader and the asset picker
// write. v1 (clip A) is spawned WITH its meta, so the creation-time reload
// restores it on any build (the positive control). The envelope is an opaque
// Y.Doc update, so v2 is produced by moving the LIVE doc to clip B's handle
// (which a fixed build also re-attaches immediately) and saving; then v1 is
// loaded over the rack and v2 over that — two literal same-session loads at
// the reused id. After the last one the element must hold clip B's object
// URL (not A's), be DECODING clip B (its duration matches B decoded on its
// own) and be MOVING (wrap-safe forward progress) — liveness, never presence.
// A build without the fix keeps clip A's URL through both loads and fails on
// the URL and the duration.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIP_A = fileURLToPath(new URL('../fixtures/lobby-clip.webm', import.meta.url));
/** ⚠ THE LONG FIXTURE (#1577) FOR THE LOAD TARGET. The post-load claim is
 *  "clip B is MOVING", and videobox does not loop: a short clip (the 1 s
 *  `av-clip.webm` was tried first) reaches its end under the drift correction
 *  before the observation window opens and reads as zero progress — a fixture
 *  artefact, not the defect. 120 s makes the end unreachable inside this spec. */
const CLIP_B = fileURLToPath(new URL('../fixtures/lobby-clip-long.webm', import.meta.url));
const H_A = 'e2e-load-staleness-a';
const H_B = 'e2e-load-staleness-b';

/** The app's own handle store — same DB, store and blob-record shape as
 *  `$lib/video/video-file-store` (`putVideoFileBlob`). */
const DB_NAME = 'patchtogether-video-handles';
const DB_VERSION = 1;
const STORE = 'handles';

/** Forward media-time that must accumulate in the observation window — the
 *  point is "moving at all" on a SwiftShader runner, not a rate. The window
 *  caps a failure; the gate is the accumulated progress. */
const OBSERVE_MS = 2_500;
const MIN_PROGRESS_S = 0.3;
const BOOT_CAP_MS = 90_000;

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_CAP_MS });
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __ensureEngine?: unknown }).__ensureEngine === 'function',
  );
  await page.evaluate(async () => {
    await (globalThis as unknown as { __ensureEngine: () => Promise<unknown> }).__ensureEngine();
  });
  return errors;
}

/** Seed both clips as granted blob handles, exactly as the perf-zip loader
 *  and the asset picker do, and return each clip's independently decoded
 *  duration (the reference the node element is later compared against). */
async function seedHandles(page: Page): Promise<{ durA: number; durB: number }> {
  const entries = [
    { id: H_A, name: 'clip-a.webm', b64: readFileSync(CLIP_A).toString('base64') },
    { id: H_B, name: 'clip-b.webm', b64: readFileSync(CLIP_B).toString('base64') },
  ];
  const durations = await page.evaluate(
    async ({ entries, DB_NAME, DB_VERSION, STORE }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('open failed'));
      });
      const out: number[] = [];
      for (const e of entries) {
        const bytes = Uint8Array.from(atob(e.b64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'video/webm' });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ __blobHandle: true, blob, name: e.name }, e.id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('put failed'));
        });
        // Decode it on a throwaway element: the reference duration.
        const url = URL.createObjectURL(blob);
        const dur = await new Promise<number>((resolve) => {
          const v = document.createElement('video');
          v.preload = 'metadata';
          v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
          v.addEventListener('error', () => resolve(-1), { once: true });
          v.src = url;
        });
        URL.revokeObjectURL(url);
        out.push(dur);
      }
      db.close();
      return out;
    },
    { entries, DB_NAME, DB_VERSION, STORE },
  );
  const [durA, durB] = durations as [number, number];
  expect(durA, 'clip A decodes').toBeGreaterThan(0);
  expect(durB, 'clip B decodes').toBeGreaterThan(0);
  // The fixture pair must be DISTINGUISHABLE, or "it decodes B now" is not a
  // claim. A loud failure here means the fixture choice is wrong, not the fix.
  expect(Math.abs(durA - durB), 'the two fixtures differ in duration').toBeGreaterThan(0.05);
  return { durA, durB };
}

/** Spawn a video node WITH its saved meta in ONE transaction — the shape a
 *  loaded rack has when its controller is created, so the creation-time
 *  reload restores clip A on any build. */
async function seedVideoNode(page: Page, id: string, type: string, handleId: string, name: string): Promise<void> {
  await page.evaluate(
    ({ id, type, handleId, name }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const k of Object.keys(w.__patch.edges)) delete w.__patch.edges[k];
        for (const k of Object.keys(w.__patch.nodes)) delete w.__patch.nodes[k];
        w.__patch.nodes[id] = {
          id,
          type,
          domain: 'video',
          position: { x: 120, y: 120 },
          params: {},
          data: {
            fileMeta: { name, duration: 0, handleId },
            isPlaying: true,
            lastSyncTime: Date.now(),
            lastSyncPosition: 0,
          },
        };
      });
    },
    { id, type, handleId, name },
  );
  await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`).first()).toBeVisible({ timeout: BOOT_CAP_MS });
}

/** Move the LIVE doc's slot-0 meta to another handle — what the asset picker
 *  and a peer's load do, and what produces the v2 envelope here. */
async function writeMeta(page: Page, id: string, handleId: string, name: string): Promise<void> {
  await page.evaluate(
    ({ id, handleId, name }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const d = w.__patch.nodes[id]!.data;
        d.fileMeta = { name, duration: 0, handleId };
        d.isPlaying = true;
      });
    },
    { id, handleId, name },
  );
}

async function saveEnvelope(page: Page): Promise<unknown> {
  const env = await page.evaluate(() => {
    const w = window as unknown as { __persistence?: { save?: () => unknown } };
    return w.__persistence?.save?.();
  });
  expect(env, '__persistence.save() unavailable — DEV build expected').toBeTruthy();
  return env;
}

async function loadSameSession(page: Page, env: unknown, id: string): Promise<void> {
  await page.evaluate((e) => {
    const w = window as unknown as { __persistence: { load: (env: unknown) => unknown } };
    w.__persistence.load(e);
  }, env);
  await expect(page.locator(`.svelte-flow__node[data-id="${id}"]`).first()).toBeVisible({ timeout: BOOT_CAP_MS });
}

interface ElState { src: string; duration: number; paused: boolean; time: number }

async function readEl(page: Page, testid: string): Promise<ElState | null> {
  return page.evaluate((t) => {
    const v = document.querySelector(`video[data-testid="${t}"]`) as HTMLVideoElement | null;
    if (!v) return null;
    return { src: v.currentSrc || v.src || '', duration: v.duration, paused: v.paused, time: v.currentTime };
  }, testid);
}

/** Wait until the node element holds SOME object URL other than `notSrc`,
 *  has metadata, and is playing. */
async function waitForSource(page: Page, testid: string, notSrc: string, message: string): Promise<ElState> {
  await expect
    .poll(
      async () => {
        const s = await readEl(page, testid);
        return !!s && s.src.startsWith('blob:') && s.src !== notSrc && Number.isFinite(s.duration) && s.duration > 0 && !s.paused;
      },
      { timeout: 30_000, message },
    )
    .toBe(true);
  return (await readEl(page, testid))!;
}

/** Wrap-safe, seek-proof forward playback progress, sampled IN THE PAGE. */
async function measureProgress(page: Page, testid: string, ms: number): Promise<number> {
  return page.evaluate(
    async ({ t, windowMs }) => {
      const el = document.querySelector(`video[data-testid="${t}"]`) as HTMLVideoElement | null;
      if (!el) return -1;
      let progress = 0;
      let prevT = el.currentTime;
      let prevMs = performance.now();
      const startMs = prevMs;
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          const nowMs = performance.now();
          const t2 = el.currentTime;
          const dtMs = nowMs - prevMs;
          const rate = el.paused ? 0 : el.playbackRate || 1;
          const delta = t2 - prevT;
          if (delta > 0) progress += Math.min(delta, (dtMs / 1000) * rate);
          prevT = t2;
          prevMs = nowMs;
          if (nowMs - startMs >= windowMs) { clearInterval(iv); resolve(); }
        }, 100);
      });
      return progress;
    },
    { t: testid, windowMs: ms },
  );
}

async function engineHasElement(page: Page, nodeId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } };
    };
    try { return w.__engine!().getDomain('video').read(id, 'hasVideoElement') === true; } catch { return false; }
  }, nodeId);
}

async function readDocMeta(page: Page, id: string): Promise<{ name?: string; duration?: number; handleId?: string } | null> {
  return page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { fileMeta?: { name?: string; duration?: number; handleId?: string } } }> };
    };
    const m = w.__patch.nodes[nid]?.data?.fileMeta;
    return m ? { name: m.name, duration: m.duration, handleId: m.handleId } : null;
  }, id);
}

async function runLeg(page: Page, type: 'videobox' | 'videovarispeed', testid: string): Promise<void> {
  const errors = await boot(page);
  const { durB } = await seedHandles(page);
  const id = `${type}-reused`;

  // v1 LIVE (positive control, any build): clip A restores from its handle
  // with no surface mounted, and MOVES.
  await seedVideoNode(page, id, type, H_A, 'clip-a.webm');
  const v1 = await waitForSource(page, testid, '', 'v1: clip A restores from the saved handle and plays');
  expect(await measureProgress(page, testid, OBSERVE_MS), 'v1: clip A is moving').toBeGreaterThan(MIN_PROGRESS_S);
  const envV1 = await saveEnvelope(page);

  // Produce v2: the doc moves to clip B's handle (a fixed build re-attaches
  // here too; a broken one does not — either way the ENVELOPE is v2).
  await writeMeta(page, id, H_B, 'clip-b.webm');
  const envV2 = await saveEnvelope(page);

  // TWO SAME-SESSION LOADS at the reused id: back to v1, then to v2.
  await loadSameSession(page, envV1, id);
  await expect
    .poll(async () => (await readDocMeta(page, id))?.handleId, { message: 'the doc shows v1 after the first load' })
    .toBe(H_A);
  await loadSameSession(page, envV2, id);
  await expect
    .poll(async () => (await readDocMeta(page, id))?.handleId, { message: 'the doc shows v2 after the second load' })
    .toBe(H_B);

  // THE CLAIM: the element holds clip B — a different object URL than clip
  // A's, decoding B (duration matches B decoded on its own) and MOVING.
  const v2 = await waitForSource(page, testid, v1.src, 'AFTER THE LOAD: the element re-attached to a NEW source and plays');
  expect(v2.src, 'a different object URL than clip A').not.toBe(v1.src);
  expect(Math.abs(v2.duration - durB), `decoding clip B (duration ${v2.duration} vs B ${durB})`).toBeLessThan(0.05);
  expect(await measureProgress(page, testid, OBSERVE_MS), 'clip B is moving after the load').toBeGreaterThan(MIN_PROGRESS_S);
  expect(await engineHasElement(page, id), 'the engine still holds the element').toBe(true);
  // ...and the load path wrote B's real metadata back, so surfaces agree.
  await expect
    .poll(async () => (await readDocMeta(page, id))?.duration ?? 0, { message: 'the doc carries clip B\'s decoded duration' })
    .toBeGreaterThan(0);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
}

test.describe('same-session load at a REUSED id re-attaches the loaded clip (#3)', () => {
  test('videobox', async ({ page }) => {
    test.setTimeout(180_000);
    await runLeg(page, 'videobox', 'videobox-video');
  });

  test('videovarispeed (slot 0)', async ({ page }) => {
    test.setTimeout(180_000);
    await runLeg(page, 'videovarispeed', 'videovarispeed-video');
  });
});
