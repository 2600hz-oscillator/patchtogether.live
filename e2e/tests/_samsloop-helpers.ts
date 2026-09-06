// e2e/tests/_samsloop-helpers.ts
//
// Shared reads for the SAMSLOOP record specs. Not a spec file (leading `_`,
// same convention as _helpers.ts) so Playwright does not collect it.
//
// ⚠ WHY THIS EXISTS: what SAMSLOOP records at is a function of the machine,
// not of the code. The RATE switch is a REQUEST; `downsample` decimates by an
// INTEGER factor, so a 48 kHz AudioContext cannot produce 44.1 kHz and a
// 44.1 kHz one cannot produce 48. Hard-coding `expect(sample.rate).toBe(44100)`
// — which is what these specs used to do — is therefore an assertion about the
// RUNNER, and it was green only because it agreed with the old (wrong) tag.
// Ask the page what its context runs at and derive the expectation, so the
// assertion is renderer-independent by construction rather than by luck.

import type { Page } from '@playwright/test';

/** The live AudioContext's sample rate, as the tap will capture at. */
export async function readContextSampleRate(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { hasDomain?: (d: string) => boolean; getDomain?: (d: string) => { ctx?: { sampleRate?: number } } } | null;
    };
    const eng = w.__engine?.();
    if (!eng?.hasDomain?.('audio')) return 0;
    return eng.getDomain?.('audio')?.ctx?.sampleRate ?? 0;
  });
}

/** Mirror of `samsloopAchievedRate` for the e2e side. Kept tiny and stated
 *  in one line so the duplication is obviously the same rule; the authority
 *  is `$lib/audio/modules/samsloop-record`, pinned by its own unit tests. */
export function expectedAchievedRate(captureRate: number, switchRate: number): number {
  if (captureRate <= 0 || switchRate <= 0) return 0;
  const factor = captureRate <= switchRate ? 1 : Math.max(1, Math.round(captureRate / switchRate));
  return captureRate / factor;
}

export interface SamsloopSampleRead {
  bytesLen: number;
  rate: number;
  bits: number;
  channels: number;
  durationSec: number;
}

/** Read `node.data.sample`'s metadata, or null when nothing is recorded. */
export async function readSample(page: Page, nodeId: string): Promise<SamsloopSampleRead | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { sample?: { byteLength: number; rate: number; bits: number; channels: number; durationSec: number } } }> };
    };
    const s = w.__patch.nodes[id]?.data?.sample;
    if (!s) return null;
    return {
      bytesLen: s.byteLength,
      rate: s.rate,
      bits: s.bits,
      channels: s.channels,
      durationSec: s.durationSec,
    };
  }, nodeId);
}

// ── DEFAULT-SHELL surface helpers (S2) ──────────────────────────────────────
//
// The card is gone from the default boot; SAMSLOOP's non-ranked affordances —
// the FILE cell, REC/EXPORT, the waveform — live in the dock full view.
// Everything is PANE-scoped because the lane tile ranks some of the same cell
// testids (`shell-cell-samsloop-trigger`).

import { expect } from '@playwright/test';

/** Open the SAMSLOOP dock full view and return the PANE locator. */
export async function openSamsloopPane(page: Page, id = 's') {
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
  await expect(pane.getByTestId('samsloop-face-canvas')).toBeVisible({ timeout: 30_000 });
  return pane;
}

/** The NODE-keyed registry's recording flag — the recording-state observable
 *  on the shell (the card's REC/STOP label flip died with the card; the cell
 *  label is static by design). */
export async function samsloopIsRecording(page: Page, id = 's'): Promise<boolean> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __samsloopRecording: (x: string) => { recording: boolean } })
        .__samsloopRecording(n).recording,
    id,
  );
}
