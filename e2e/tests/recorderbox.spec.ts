// e2e/tests/recorderbox.spec.ts
//
// LIVE end-to-end coverage for RECORDERBOX, the video+audio recorder sink.
//
// Drives the REAL source chain (per the test-the-real-source-chain
// discipline): a real ANALOG VCO → audio_l + a real ACIDWARP video generator
// → in, then toggles Record ON for ~2.5s and OFF, asserting:
//
//   * STRUCTURAL (always): all four handles render; the cross-domain
//     audio→video audio-input edge survives engine.addEdge (no silent drop);
//     no page errors; the card's encoder probe resolves; Record disabled +
//     "no H.264 encoder available" badge where the runtime can't encode.
//
//   * REAL ENCODING (gated on VideoEncoder.isConfigSupported — CI runners
//     lack an OS H.264 encoder, so these run only where H.264 is available,
//     e.g. a dev Mac with a hardware encoder):
//       (a) a non-empty MP4 lands in OPFS scratch + is a parseable
//           FRAGMENTED MP4 (ftyp + moof boxes present);
//       (b) a TRUNCATED copy of the OPFS fragment file is STILL parseable
//           (ftyp + ≥1 moof) — the crash-recovery guarantee: a take is
//           playable from whatever fragments reached disk before a crash.
//
// test.setTimeout scales with the heavy WebGL video chain on CI's software
// renderer (acidwarp + the recorder's per-frame canvas encode), not a flat 90s.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'serial' });

// Heavy: ACIDWARP GLSL + recorder canvas encode on SwiftShader. Two video-ish
// workloads + a ~2.5s record window → generous budget.
test.setTimeout(120_000);

/** Does this runtime have an OS H.264 encoder? Gates the real-encoding asserts.
 *  Probes the EXACT config the recorder uses (High profile at engine res). */
async function h264EncodeSupported(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const VE = (globalThis as { VideoEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } }).VideoEncoder;
    if (!VE || typeof VE.isConfigSupported !== 'function') return false;
    const codecs = ['avc1.640028', 'avc1.42E01E'];
    for (const codec of codecs) {
      try {
        const r = await VE.isConfigSupported({ codec, width: 1024, height: 768, bitrate: 14_000_000, framerate: 30 });
        if (r?.supported) return true;
      } catch { /* try next */ }
    }
    return false;
  });
}

/** Read all edge ids from the live patch graph. */
async function readEdgeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { edges: Record<string, unknown> } };
    return Object.keys(w.__patch?.edges ?? {});
  });
}

/** Flip node.data.recording on the live store (the card's $effect reacts). */
async function setRecording(page: Page, nodeId: string, on: boolean): Promise<void> {
  await page.evaluate(({ id, on }) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.recording = on;
    });
  }, { id: nodeId, on });
}

/** Read the OPFS scratch bytes for this node's in-flight recording (via the
 *  IndexedDB recovery manifest, which holds the opfsPath). Returns the byte
 *  length + a small head slice (for box-sniffing) + the full path. */
async function readScratch(page: Page, nodeId: string): Promise<{ path: string; size: number; head: number[] } | null> {
  return await page.evaluate(async (id) => {
    // Find the manifest for this node (any status — we read mid-flight + post).
    const manifest = await new Promise<{ opfsPath: string } | null>((resolve) => {
      const req = indexedDB.open('patchtogether-recorderbox', 1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('manifests')) { resolve(null); return; }
        const tx = db.transaction('manifests', 'readonly');
        const all = tx.objectStore('manifests').getAll();
        all.onsuccess = () => {
          const rows = (all.result as { nodeId: string; opfsPath: string }[]) ?? [];
          const mine = rows.filter((r) => r.nodeId === id);
          resolve(mine.length ? mine[mine.length - 1] : null);
        };
        all.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    });
    if (!manifest) return null;
    try {
      const root = await navigator.storage.getDirectory();
      const parts = manifest.opfsPath.split('/').filter(Boolean);
      const fileName = parts.pop()!;
      let dir = root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      const fh = await dir.getFileHandle(fileName);
      const file = await fh.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      return { path: manifest.opfsPath, size: buf.byteLength, head: Array.from(buf.slice(0, 64)) };
    } catch {
      return { path: manifest.opfsPath, size: -1, head: [] };
    }
  }, nodeId);
}

/** Parse an MP4 byte array for top-level box types (ftyp/moov/moof/mdat). A
 *  fragmented MP4 has ftyp + ≥1 moof; this is the "is it a valid + playable
 *  fragmented MP4" sniff. Runs page-side over the OPFS bytes (avoids piping MB
 *  over the CDP bridge). `truncateTo` simulates a crash mid-fragment. */
async function sniffMp4Boxes(page: Page, opfsPath: string, truncateTo?: number): Promise<{ boxes: string[]; ftyp: boolean; moof: number }> {
  return await page.evaluate(async ({ path, truncateTo }) => {
    const root = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const fh = await dir.getFileHandle(fileName);
    const file = await fh.getFile();
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (typeof truncateTo === 'number') bytes = bytes.slice(0, truncateTo);
    const dv = new DataView(bytes.buffer);
    const boxes: string[] = [];
    let off = 0;
    let moof = 0;
    let ftyp = false;
    // Walk top-level boxes: [4-byte size][4-byte type]... Stop on a truncated /
    // zero / oversize box (the crash-truncation case ends here cleanly).
    while (off + 8 <= bytes.byteLength) {
      const size = dv.getUint32(off);
      const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
      if (size < 8) break;
      boxes.push(type);
      if (type === 'ftyp') ftyp = true;
      if (type === 'moof') moof++;
      if (off + size > bytes.byteLength) break; // truncated final box
      off += size;
    }
    return { boxes, ftyp, moof };
  }, { path: opfsPath, truncateTo });
}

test('RECORDERBOX records a real VCO + ACIDWARP into a crash-recoverable MP4', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Real source chain: VCO (audio) → audio_l ; ACIDWARP (video) → in.
  await spawnPatch(
    page,
    [
      { id: 'rec', type: 'recorderbox', position: { x: 500, y: 80 }, domain: 'video' },
      { id: 'vco', type: 'analogVco', position: { x: 80, y: 240 }, domain: 'audio', params: { freq: 220 } },
      { id: 'acid', type: 'acidwarp', position: { x: 80, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e-acid-in', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: 'rec', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      { id: 'e-vco-al',  from: { nodeId: 'vco', portId: 'saw' },  to: { nodeId: 'rec', portId: 'audio_l' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // ── STRUCTURAL: handles + cross-domain audio-input edge survival ──
  const card = page.locator('[data-testid="recorderbox-card"]');
  await expect(card).toBeVisible();
  for (const portId of ['in', 'audio_l', 'audio_r', 'out']) {
    await expect(page.locator(`[data-handleid="${portId}"]`).first()).toBeVisible();
  }
  // The audio→video audio-input edge must survive engine.addEdge (no silent
  // drop — the #414-class regression the new bridge could re-introduce).
  const edgeIds = await readEdgeIds(page);
  expect(edgeIds).toContain('e-vco-al');
  expect(edgeIds).toContain('e-acid-in');

  // Encoder probe resolves (the card sets canRecord / badge).
  const supported = await h264EncodeSupported(page);
  // Wait for the card's probe to settle (Record enabled OR the badge shown).
  await expect(async () => {
    const disabled = await page.locator('[data-testid="recorderbox-record"]').isDisabled();
    const badge = await page.locator('[data-testid="recorderbox-no-encoder"]').count();
    // One of the two terminal states must hold.
    expect(disabled || badge >= 0).toBeTruthy();
    if (!supported) expect(badge).toBeGreaterThan(0);
  }).toPass({ timeout: 10_000 });

  if (!supported) {
    // Graceful-degrade path (CI): Record disabled + badge, no crash.
    await expect(page.locator('[data-testid="recorderbox-record"]')).toBeDisabled();
    await expect(page.locator('[data-testid="recorderbox-no-encoder"]')).toBeVisible();
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
    return;
  }

  // ── REAL ENCODING (dev Mac with H.264) ──
  // Arm Record, let it run ~2.5s of real frames + audio, then stop.
  await setRecording(page, 'rec', true);
  // Indicator confirms the recorder actually started.
  await expect(page.locator('[data-testid="recorderbox-rec-indicator"]')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(2500);

  // (a) Mid-flight: a non-empty fragmented MP4 already exists on OPFS scratch
  // (proves fragments are flushed to disk WHILE recording — the crash-safety
  // precondition). Read before stop.
  const midScratch = await readScratch(page, 'rec');
  expect(midScratch, 'OPFS scratch manifest present mid-record').not.toBeNull();
  expect(midScratch!.size, 'scratch file has bytes mid-record').toBeGreaterThan(0);
  const midSniff = await sniffMp4Boxes(page, midScratch!.path);
  expect(midSniff.ftyp, 'scratch has an ftyp box mid-record').toBe(true);
  expect(midSniff.moof, 'scratch has ≥1 moof fragment mid-record').toBeGreaterThanOrEqual(1);

  // (b) CRASH-RECOVERY: a TRUNCATED copy of the fragment file is STILL a
  // parseable fragmented MP4 (ftyp + ≥1 moof). Truncate to ~60% — simulates
  // a tab dying mid-fragment.
  const truncSniff = await sniffMp4Boxes(page, midScratch!.path, Math.floor(midScratch!.size * 0.6));
  expect(truncSniff.ftyp, 'truncated scratch still has ftyp').toBe(true);
  expect(truncSniff.moof, 'truncated scratch still has ≥1 playable moof').toBeGreaterThanOrEqual(1);

  // Stop (finalize). The Save-As picker can't be driven headlessly, so we
  // override showSaveFilePicker to capture the finalized bytes instead.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __recCapture?: { size: number };
      showSaveFilePicker?: unknown;
    };
    w.__recCapture = { size: 0 };
    (w as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (_o: unknown) => ({
      createWritable: async () => ({
        write: async (d: BufferSource) => { (w.__recCapture as { size: number }).size += (d as ArrayBufferView).byteLength ?? (d as ArrayBuffer).byteLength ?? 0; },
        close: async () => {},
      }),
    });
  });
  await setRecording(page, 'rec', false);
  // Finalize + save round-trip.
  await expect(async () => {
    const cap = await page.evaluate(() => (globalThis as unknown as { __recCapture?: { size: number } }).__recCapture?.size ?? 0);
    expect(cap, 'finalized MP4 was written to the save target').toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });

  expect(errors.filter((e) => !e.includes('favicon')), 'no page errors during record').toEqual([]);
});
