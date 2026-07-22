// e2e/tests/mobile-synth-flows.spec.ts
//
// POCKET MODULAR (/m/synth) — transport, rack pager, faceplate interactivity,
// and module lifecycle, driven at a real iPhone-ish touch viewport.
//
// These exercise the parts the audibility spec (mobile-synth.spec) does not:
// the header transport MUST actually start/stop the sound and move the tempo
// (it drove an unwired TIMELORDE before — ▶/■ and BPM were inert), the pager
// must render + be interactive for every module, and add/remove/undo must be
// clean. Mobile emulation is per-spec (MOBILE_USE), never a new project.

import { test, expect } from '@playwright/test';
import {
  MOBILE_USE,
  AUDIBLE_RMS,
  bootFirstBleep,
  bootEmptyRack,
  edgeCount,
  nodeParam,
  readOutputRms,
} from './_mobile-helpers';

test.use(MOBILE_USE);

test.describe('pocket modular — transport', () => {
  test('▶/■ actually stops and resumes the sound', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await bootFirstBleep(page);

    // The sound is the SEQUENCER's free-running clock — tapping stop must
    // silence it (it kept playing when the transport only touched timelorde).
    expect(await nodeParam(page, 'sequencer', 'isPlaying')).toBe(1);
    await expect(page.getByTestId('m-run-toggle')).toContainText('■');

    await page.getByTestId('m-run-toggle').tap();
    expect(await nodeParam(page, 'sequencer', 'isPlaying')).toBe(0);
    await expect(page.getByTestId('m-run-toggle')).toContainText('▶');
    // Audio decays to silence (delay tail included) once the gate goes low.
    await expect
      .poll(() => readOutputRms(page), { timeout: 20_000, message: 'stop silences the chain' })
      .toBeLessThan(0.005);

    // ▶ resumes it.
    await page.getByTestId('m-run-toggle').tap();
    expect(await nodeParam(page, 'sequencer', 'isPlaying')).toBe(1);
    await expect
      .poll(() => readOutputRms(page), { timeout: 20_000, message: 'play resumes the chain' })
      .toBeGreaterThan(AUDIBLE_RMS);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('primary controls meet the 44px touch-target floor', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    const targets = [
      'm-run-toggle',
      'm-undo',
      'm-tab-rack',
      'm-tab-patch',
      'm-tab-mix',
      'm-add-fab',
    ];
    for (const id of targets) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} has no box`).not.toBeNull();
      expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${id} width`).toBeGreaterThanOrEqual(44);
    }
    // The BPM steppers (min 44px square).
    for (const label of ['bpm up', 'bpm down']) {
      const box = await page.getByLabel(label).boundingBox();
      expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(44);
    }
  });

  test('BPM controls the audible sequencer tempo + the header reflects it', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);

    // The header must show the AUDIBLE tempo (the running sequencer), not a
    // disconnected node's default.
    const seqBpm = Math.round((await nodeParam(page, 'sequencer', 'bpm')) ?? 0);
    await expect(page.getByTestId('m-bpm')).toHaveText(String(seqBpm));

    for (let i = 0; i < 5; i++) await page.getByLabel('bpm up').tap();
    // The sequencer's own tempo moved (the sound is faster), and the header
    // tracks it.
    await expect
      .poll(async () => Math.round((await nodeParam(page, 'sequencer', 'bpm')) ?? 0), {
        timeout: 5_000,
        message: 'sequencer bpm increased',
      })
      .toBeGreaterThan(seqBpm);
    const afterSeq = Math.round((await nodeParam(page, 'sequencer', 'bpm')) ?? 0);
    await expect(page.getByTestId('m-bpm')).toHaveText(String(afterSeq));
    // The master clock stays locked to the same tempo.
    expect(Math.round((await nodeParam(page, 'timelorde', 'bpm')) ?? 0)).toBe(afterSeq);
  });
});

test.describe('pocket modular — rack pager', () => {
  test('pages through every module; each renders in a CardStage', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await bootFirstBleep(page);

    const seen = new Set<string>();
    // 8 modules minus mixmstrs (jumps to MIX) = 7 pager pages; walk more than
    // that to prove wrap works without error.
    for (let i = 0; i < 9; i++) {
      await expect(page.getByTestId('cardstage')).toBeVisible();
      const nt = await page.getByTestId('cardstage').getAttribute('data-node-type');
      if (nt) seen.add(nt);
      await page.getByLabel('next module').tap();
      await page.waitForTimeout(120);
    }
    // The signal-flow modules all mounted; mixmstrs never mounts in the pager.
    expect([...seen].sort()).toEqual(
      ['adsr', 'analogVco', 'audioOut', 'delay', 'sequencer', 'timelorde', 'vca'].sort(),
    );
    expect(seen.has('mixmstrs')).toBe(false);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the sequencer faceplate is interactive inside the CardStage', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    // FIRST BLEEP lands on the sequencer (spawnSeq 0). Step index 1 is OFF in
    // the seed; tapping its gate toggle must flip node.data.steps[1].on — the
    // real card is live inside the single-node flow.
    await expect(page.getByTestId('cardstage')).toHaveAttribute('data-node-type', 'sequencer');
    const gate = page.locator('[data-testid^="seq-gate-"]').nth(1);
    await expect(gate).toBeVisible();
    const before = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { type: string; data?: { steps?: { on: boolean }[] } } | undefined> };
      };
      const s = Object.values(w.__patch?.nodes ?? {}).find((n) => n?.type === 'sequencer');
      return s?.data?.steps?.[1]?.on ?? null;
    });
    await gate.tap();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __patch?: { nodes: Record<string, { type: string; data?: { steps?: { on: boolean }[] } } | undefined> };
          };
          const s = Object.values(w.__patch?.nodes ?? {}).find((n) => n?.type === 'sequencer');
          return s?.data?.steps?.[1]?.on ?? null;
        }),
      )
      .toBe(!before);
  });
});

test.describe('pocket modular — module lifecycle', () => {
  test('add a module then remove it — cables drop, undo restores', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await bootFirstBleep(page);

    // Add reverb + wire it (delay.audio fans into it) so removal disconnects a
    // real cable.
    await page.getByTestId('m-add-fab').tap();
    await page.getByTestId('m-add-reverb').tap();
    await expect(page.getByTestId('m-pager-title')).toHaveText('reverb');
    await page.getByTestId('m-tab-patch').tap();
    await page.getByTestId('m-rail-from').tap();
    await page.getByTestId('m-pick-delay').tap();
    await page.getByTestId('m-rail-to').tap();
    await page.getByTestId('m-pick-reverb').tap();
    await page.getByTestId('m-cell-audio-audio').tap();
    await expect.poll(() => edgeCount(page)).toBeGreaterThan(9);
    const withReverb = await edgeCount(page);

    // Remove reverb from its pager header. The UndoManager's 500ms
    // captureTimeout merges edit BURSTS into one unit and Playwright taps far
    // faster than a human, so delimit the remove as its own undo unit (the
    // documented Yjs seam) — otherwise ONE undo would revert the add+patch too.
    await page.evaluate(() =>
      (globalThis as { __undoManager?: { stopCapturing: () => void } }).__undoManager?.stopCapturing(),
    );
    await page.getByTestId('m-tab-rack').tap();
    await page.getByTestId('m-chip-reverb').tap();
    await page.getByTestId('m-pager-more').tap();
    await expect(page.getByTestId('m-remove-sheet')).toBeVisible();
    await page.getByTestId('m-remove-confirm').tap();
    await expect(page.getByTestId('m-chip-reverb')).toHaveCount(0);
    await expect.poll(() => edgeCount(page)).toBeLessThan(withReverb);

    // Undo restores both the node and its cable.
    await page.getByTestId('m-undo').tap();
    await expect(page.getByTestId('m-chip-reverb')).toHaveCount(1);
    await expect.poll(() => edgeCount(page)).toBe(withReverb);

    // The chain never went silent through all of that.
    expect(await readOutputRms(page)).toBeGreaterThan(AUDIBLE_RMS);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('timelorde has no remove affordance (undeletable)', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    await page.getByTestId('m-chip-timelorde').tap();
    await expect(page.getByTestId('cardstage')).toHaveAttribute('data-node-type', 'timelorde');
    // The "…" remove button is hidden for undeletable modules.
    await expect(page.getByTestId('m-pager-more')).toHaveCount(0);
  });

  test('add-then-immediately-delete + rapid tab switching stays stable', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await bootFirstBleep(page);
    await page.getByTestId('m-add-fab').tap();
    await page.getByTestId('m-add-delay').tap();
    await expect(page.getByTestId('m-pager-title')).toHaveText(/delay/);
    await page.getByTestId('m-pager-more').tap();
    await page.getByTestId('m-remove-confirm').tap();

    for (let i = 0; i < 8; i++) {
      await page.getByTestId('m-tab-patch').tap();
      await page.getByTestId('m-tab-mix').tap();
      await page.getByTestId('m-tab-rack').tap();
    }
    // Still alive + audible after the churn.
    await expect
      .poll(() => readOutputRms(page), { timeout: 15_000 })
      .toBeGreaterThan(AUDIBLE_RMS);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('pocket modular — session persistence', () => {
  test('autosaves on backgrounding + restores the scene after a reload', async ({ page }) => {
    test.setTimeout(120_000);
    await bootFirstBleep(page);
    const nodesBefore = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
      return Object.keys(w.__patch?.nodes ?? {}).length;
    });
    expect(nodesBefore).toBeGreaterThan(1);

    // iOS evicts background tabs; the doc is memory-only. Simulate the tab
    // going hidden (fires the visibilitychange autosave), then reload.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.reload();
    await page.waitForLoadState('networkidle');

    // The start card now offers "restore last session".
    await expect(page.getByTestId('m-restore')).toBeVisible();
    await page.getByTestId('m-restore').tap();
    await expect(page.getByTestId('m-tabbar')).toBeVisible({ timeout: 20_000 });

    // The whole scene came back and it's audible again.
    const nodesAfter = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
      return Object.keys(w.__patch?.nodes ?? {}).length;
    });
    expect(nodesAfter).toBe(nodesBefore);
    await expect(page.getByTestId('m-chip-sequencer')).toBeVisible();
    await expect
      .poll(() => readOutputRms(page), { timeout: 60_000, message: 'restored scene is audible' })
      .toBeGreaterThan(AUDIBLE_RMS);
  });
});

test.describe('pocket modular — start options', () => {
  test('empty rack boots to timelorde+mixmstrs+audioOut, silent, no errors', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await bootEmptyRack(page);
    const types = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch?: { nodes: Record<string, { type: string } | undefined> } };
      return Object.values(w.__patch?.nodes ?? {}).map((n) => n?.type).sort();
    });
    expect(types).toEqual(['audioOut', 'mixmstrs', 'timelorde']);
    // No source yet → silent, but the master is pre-wired (nothing errors).
    expect(await readOutputRms(page)).toBeLessThan(0.005);
    // Transport still shows (timelorde exposes `running`).
    await expect(page.getByTestId('m-transport')).toBeVisible();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
