// e2e/tests/sequencer-transport.spec.ts
//
// PR feat/sequencer-transport-quicksave — coverage for the new shared
// transport + 4-slot quicksave system on Sequencer / DRUMSEQZ / SCORE /
// POLYSEQZ (POLYSEQZ added in PR feat/polyseqz-transport-parity).
//
// What we cover here:
//   1. SAVE then LOAD round-trips a snapshot exactly (per module).
//   2. QUEUE → button shows queued state; sequence-end swap performed by
//      the engine (we read node.data.queuedSlot to verify the queue is
//      armed; full audio-thread swap is covered by the ART helpers).
//   3. PLAY toggle + RESET button.
//   4. Multiplayer: slot data Y.Doc-syncs across two browser contexts.
//
// Pattern lifted from picturebox-sync.spec.ts for the @collab two-context
// rackspace test.

import { test, expect, type Page, type Browser } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { SYNC_BUDGET_MS, SYNC_POLL_INTERVALS } from './_collab-helpers';

test.describe.configure({ mode: 'parallel' });

const SEQUENCERS: Array<{ type: string; nodeId: string; spawnParams: Record<string, number>; cellSelector: string }> = [
  {
    type: 'sequencer',
    nodeId: 'seq-tx',
    spawnParams: { isPlaying: 0, length: 16 },
    // Sequencer has no per-cell test id at module name; use the grid container.
    cellSelector: '[data-testid="seq-grid-seq-tx"]',
  },
  {
    type: 'drumseqz',
    nodeId: 'drum-tx',
    spawnParams: { isPlaying: 0, length: 16 },
    cellSelector: '[data-testid="drumseqz-grid-drum-tx"]',
  },
  {
    type: 'score',
    nodeId: 'score-tx',
    spawnParams: { isPlaying: 0 },
    cellSelector: '[data-testid="score-staff-score-tx"]',
  },
  {
    type: 'polyseqz',
    nodeId: 'poly-tx',
    spawnParams: { isPlaying: 0, length: 8 },
    cellSelector: '[data-testid="polyseqz-grid-poly-tx"]',
  },
  {
    // feat/seq: MACSEQ gained the same 8-slot quicksave + transport as the
    // base Sequencer. Its step shape is {on, midi, model} (no chord lane).
    type: 'macseq',
    nodeId: 'macseq-tx',
    spawnParams: { isPlaying: 0, length: 16 },
    cellSelector: '[data-testid="macseq-grid-macseq-tx"]',
  },
];

for (const s of SEQUENCERS) {
  test.describe(`${s.type}: quicksave + transport`, () => {
    test(`${s.type}: SAVE then LOAD round-trips the pattern snapshot`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: s.spawnParams }]);

      // Inject a non-default pattern marker into node.data so we can detect
      // the round-trip. We use a sentinel field that survives SAVE+LOAD via
      // the snapshot pipeline: the canonical per-module data field.
      await page.evaluate(
        ({ nodeId, type }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          const t = w.__patch.nodes[nodeId];
          if (!t) throw new Error('node missing');
          w.__ydoc.transact(() => {
            if (!t.data) t.data = {};
            if (type === 'sequencer') {
              const steps = Array.from({ length: 32 }, () => ({ on: false, midi: null, chord: 'mono' }));
              steps[0] = { on: true, midi: 60, chord: 'mono' };
              steps[4] = { on: true, midi: 64, chord: 'mono' };
              (t.data as Record<string, unknown>).steps = steps;
            } else if (type === 'drumseqz') {
              const tracks = Array.from({ length: 4 }, () =>
                Array.from({ length: 16 }, () => ({ on: false, midi: null })),
              );
              tracks[0][0] = { on: true, midi: 60 };
              tracks[1][4] = { on: true, midi: 67 };
              (t.data as Record<string, unknown>).tracks = tracks;
            } else if (type === 'score') {
              (t.data as Record<string, unknown>).notes = [
                { id: 'n1', bar: 0, tick: 0, duration: 'quarter', midi: 60, staffStep: 9, accidental: null },
              ];
              (t.data as Record<string, unknown>).pages = 1;
              (t.data as Record<string, unknown>).loop = false;
              (t.data as Record<string, unknown>).keySignature = 0;
              (t.data as Record<string, unknown>).dynamics = [];
              (t.data as Record<string, unknown>).ties = [];
            } else if (type === 'polyseqz') {
              const steps = Array.from({ length: 32 }, () => ({
                on: false, root: 48, quality: 'maj', inversion: 0, voicing: 'closed',
              }));
              steps[0] = { on: true, root: 60, quality: 'maj7', inversion: 0, voicing: 'open' };
              steps[3] = { on: true, root: 67, quality: 'min7', inversion: 1, voicing: 'spread' };
              (t.data as Record<string, unknown>).steps = steps;
            } else if (type === 'macseq') {
              const steps = Array.from({ length: 16 }, () => ({ on: false, midi: null, model: null }));
              steps[0] = { on: true, midi: 60, model: 8 };  // KICK
              steps[4] = { on: true, midi: 64, model: 3 };  // FM 6OP
              (t.data as Record<string, unknown>).steps = steps;
            }
            t.params.bpm = 145;
          });
        },
        { nodeId: s.nodeId, type: s.type },
      );

      // Click SAVE then slot 1.
      await page.locator(`[data-testid="quicksave-mode-save-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-1"]`).click();

      // Slot 1 should now show has-data.
      await expect(page.locator(`[data-testid="quicksave-slot-${s.nodeId}-1"]`)).toHaveAttribute(
        'data-has-data',
        'true',
      );

      // Mutate live state so it differs from slot 1.
      await page.evaluate(
        ({ nodeId, type }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          const t = w.__patch.nodes[nodeId];
          if (!t) throw new Error('node missing');
          w.__ydoc.transact(() => {
            t.params.bpm = 200;
            if (!t.data) t.data = {};
            if (type === 'sequencer') (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({ on: false, midi: null, chord: 'mono' }));
            if (type === 'drumseqz') (t.data as Record<string, unknown>).tracks = Array.from({ length: 4 }, () => Array.from({ length: 16 }, () => ({ on: false, midi: null })));
            if (type === 'score') (t.data as Record<string, unknown>).notes = [];
            if (type === 'polyseqz') (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({
              on: false, root: 48, quality: 'maj', inversion: 0, voicing: 'closed',
            }));
            if (type === 'macseq') (t.data as Record<string, unknown>).steps = Array.from({ length: 16 }, () => ({ on: false, midi: null, model: null }));
          });
        },
        { nodeId: s.nodeId, type: s.type },
      );

      // Click LOAD then slot 1.
      await page.locator(`[data-testid="quicksave-mode-load-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-1"]`).click();

      // Verify the snapshot was restored.
      const restored = await page.evaluate(
        ({ nodeId, type }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
          };
          const t = w.__patch.nodes[nodeId];
          if (!t) throw new Error('node missing');
          if (type === 'sequencer') {
            const steps = (t.data as Record<string, unknown>).steps as Array<{ on: boolean; midi: number | null }>;
            return { bpm: t.params.bpm, marker: steps?.[0]?.on === true && steps?.[0]?.midi === 60 };
          }
          if (type === 'drumseqz') {
            const tracks = (t.data as Record<string, unknown>).tracks as Array<Array<{ on: boolean; midi: number | null }>>;
            return { bpm: t.params.bpm, marker: tracks?.[0]?.[0]?.on === true && tracks?.[0]?.[0]?.midi === 60 };
          }
          if (type === 'score') {
            const notes = (t.data as Record<string, unknown>).notes as Array<{ id: string; midi: number }>;
            return { bpm: t.params.bpm, marker: notes?.length === 1 && notes[0].midi === 60 };
          }
          if (type === 'polyseqz') {
            const steps = (t.data as Record<string, unknown>).steps as Array<{
              on: boolean; root: number | null; quality: string; inversion: number; voicing: string;
            }>;
            // Verify per-step root/quality/inversion/voicing all round-trip.
            const s0 = steps?.[0];
            const s3 = steps?.[3];
            const marker =
              s0?.on === true && s0.root === 60 && s0.quality === 'maj7' && s0.inversion === 0 && s0.voicing === 'open' &&
              s3?.on === true && s3.root === 67 && s3.quality === 'min7' && s3.inversion === 1 && s3.voicing === 'spread';
            return { bpm: t.params.bpm, marker };
          }
          if (type === 'macseq') {
            const steps = (t.data as Record<string, unknown>).steps as Array<{ on: boolean; midi: number | null; model: number | null }>;
            // Verify per-step on/midi/model all round-trip (the model picker
            // is MACSEQ's signature field).
            const s0 = steps?.[0];
            const s4 = steps?.[4];
            const marker =
              s0?.on === true && s0.midi === 60 && s0.model === 8 &&
              s4?.on === true && s4.midi === 64 && s4.model === 3;
            return { bpm: t.params.bpm, marker };
          }
          return { bpm: 0, marker: false };
        },
        { nodeId: s.nodeId, type: s.type },
      );

      expect(restored.bpm).toBe(145);
      expect(restored.marker).toBe(true);
      // Last-loaded slot indicator should be visible on slot 1.
      await expect(page.locator(`[data-testid="quicksave-slot-${s.nodeId}-1"]`)).toHaveClass(
        /last-loaded/,
      );
    });

    test(`${s.type}: saves to ALL 8 slots in sequence (regression — slot ≥2 silently failed)`, async ({
      page,
    }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: s.spawnParams }]);

      const SLOTS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
      // SAVE each slot in turn. SAVE mode disarms after each click, so re-arm
      // before every slot — exactly the user flow (save slot 1, then slot 2…).
      // Pre-fix the 2nd save threw inside the Y.Doc transact (slots['1'] was an
      // already-integrated Y.Map that `{ ...coerceSlots() }` re-parented), so
      // only slot 1 ever filled. This runs across every sequencer that shares
      // the quicksave helpers (sequencer/drumseqz/score/polyseqz/macseq).
      for (const k of SLOTS) {
        await page.locator(`[data-testid="quicksave-mode-save-${s.nodeId}"]`).click();
        await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-${k}"]`).click();
      }
      // Every slot must now report filled — pre-fix, 2..8 stayed empty.
      for (const k of SLOTS) {
        await expect(
          page.locator(`[data-testid="quicksave-slot-${s.nodeId}-${k}"]`),
        ).toHaveAttribute('data-has-data', 'true');
      }
      // LOAD works off a high slot too (not just slot 1).
      await page.locator(`[data-testid="quicksave-mode-load-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-7"]`).click();
      await expect(
        page.locator(`[data-testid="quicksave-slot-${s.nodeId}-7"]`),
      ).toHaveClass(/last-loaded/);
    });

    test(`${s.type}: QUEUE arms queuedSlot in node.data`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: s.spawnParams }]);

      // Pre-populate slot 2 so it can be queued.
      await page.locator(`[data-testid="quicksave-mode-save-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-2"]`).click();

      await page.locator(`[data-testid="quicksave-mode-queue-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-2"]`).click();

      // The queued slot should appear in node.data.queuedSlot.
      const queued = await page.evaluate((nodeId) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
        };
        return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.queuedSlot;
      }, s.nodeId);
      expect(queued).toBe('2');

      // Slot 2 button should display queued styling.
      await expect(page.locator(`[data-testid="quicksave-slot-${s.nodeId}-2"]`)).toHaveAttribute(
        'data-queued',
        'true',
      );
    });

    test(`${s.type}: PLAY button toggles isPlaying`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: s.spawnParams }]);

      const playBtn = page.locator(`[data-testid="quicksave-play-${s.nodeId}"]`);
      // Initial: not playing (text contains "PLAY").
      await expect(playBtn).toContainText('PLAY');
      await playBtn.click();
      await expect(playBtn).toContainText('STOP');
      // Param mirrors UI.
      const isPlaying = await page.evaluate((nodeId) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        };
        return w.__patch.nodes[nodeId]?.params.isPlaying;
      }, s.nodeId);
      expect(isPlaying).toBe(1);
      await playBtn.click();
      await expect(playBtn).toContainText('PLAY');
    });

    test(`${s.type}: RESET button is wired (queuedSlot cleared, isPlaying not stuck)`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: s.spawnParams }]);

      // Pre-populate + queue slot 1 so we can verify RESET clears it.
      await page.locator(`[data-testid="quicksave-mode-save-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-1"]`).click();
      await page.locator(`[data-testid="quicksave-mode-queue-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-1"]`).click();

      const resetBtn = page.locator(`[data-testid="quicksave-reset-${s.nodeId}"]`);
      await resetBtn.click();

      // queuedSlot should be cleared.
      await expect
        .poll(async () =>
          await page.evaluate((nodeId) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
            };
            return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.queuedSlot;
          }, s.nodeId),
        )
        .toBeFalsy();
    });
  });
}

// ----------------------------------------------------------------------------
// feat/seq — 8 slots + NEXT / PREV / RANDOM quantized nav (engine-level).
//
// These run the real engine tick. We save patterns into a sparse set of
// occupied slots, then latch a NEXT/PREV/RANDOM nav (or queue a high slot)
// and assert the engine applies it AT SEQUENCE-END (quantized, not
// immediate) by reading node.data.lastLoadedSlot. Covered for both Sequencer
// and MACSEQ (both now opt into the extended transport CV).
// ----------------------------------------------------------------------------

const NAV_SEQUENCERS: Array<{ type: string; nodeId: string; mkStep: (on: boolean, midi: number) => Record<string, unknown> }> = [
  { type: 'sequencer', nodeId: 'seq-nav', mkStep: (on, midi) => ({ on, midi, chord: 'mono' }) },
  { type: 'macseq',    nodeId: 'macseq-nav', mkStep: (on, midi) => ({ on, midi, model: null }) },
];

for (const s of NAV_SEQUENCERS) {
  test.describe(`${s.type}: 8-slot quicksave + quantized NEXT/PREV/RANDOM nav`, () => {
    test(`${s.type}: slots 5..8 exist + a SAVE click into slot 5 round-trips (8-slot capacity)`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: { isPlaying: 0, length: 4 } }]);

      // The new high slots (5..8) must render as buttons (8-slot UI capacity).
      for (const slot of ['5', '6', '7', '8']) {
        await expect(
          page.locator(`[data-testid="quicksave-slot-${s.nodeId}-${slot}"]`),
          `slot ${slot} button present`,
        ).toBeVisible();
      }

      // A SAVE click into one of the new slots (slot 5) round-trips through
      // the same pendingMode → save pipeline the low slots use. (The low-slot
      // SAVE/LOAD is exercised by the per-module SAVE-then-LOAD test above; we
      // assert the high slots are wired into the same flow.)
      await page.locator(`[data-testid="quicksave-mode-save-${s.nodeId}"]`).click();
      await page.locator(`[data-testid="quicksave-slot-${s.nodeId}-5"]`).click();
      await expect(page.locator(`[data-testid="quicksave-slot-${s.nodeId}-5"]`)).toHaveAttribute(
        'data-has-data',
        'true',
      );

      // Seed slots 5..8 directly with FRESH plain objects (avoids the tight
      // SAVE→click reactivity race AND Yjs's "object already in tree" guard on
      // reusing existing slot Y.Maps) and assert all four high slots reflect
      // has-data — pinning the 8-slot coerceSlots envelope end-to-end through
      // the card's `slots` derived.
      await page.evaluate((nodeId) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        const t = w.__patch.nodes[nodeId];
        if (!t) throw new Error('node missing');
        w.__ydoc.transact(() => {
          if (!t.data) t.data = {};
          (t.data as Record<string, unknown>).slots = {
            '5': { bpm: 120 }, '6': { bpm: 120 }, '7': { bpm: 120 }, '8': { bpm: 120 },
          };
        });
      }, s.nodeId);

      for (const slot of ['5', '6', '7', '8']) {
        await expect(page.locator(`[data-testid="quicksave-slot-${s.nodeId}-${slot}"]`)).toHaveAttribute(
          'data-has-data',
          'true',
        );
      }
    });

    test(`${s.type}: NEXT/PREV/RANDOM nav ports render handles + queuedNav latches`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: { isPlaying: 0 } }]);

      // The 3 nav gate input handles must exist on the card (per-port test
      // also pins these registry-wide; this is the targeted assertion).
      const card = page.locator(`.svelte-flow__node-${s.type}`);
      for (const port of ['next_cv', 'prev_cv', 'random_cv']) {
        await expect(
          card.locator(`.svelte-flow__handle[data-handleid="${port}"]`),
          `${s.type} ${port} handle present`,
        ).toHaveCount(1);
      }
    });

    test(`${s.type}: queued NEXT applies at sequence-end → walks occupied slots (wraps)`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      // Short pattern (length 2) at fast BPM so sequence-ends come quickly.
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: { isPlaying: 0, length: 2, bpm: 300 } }]);

      // Seed three OCCUPIED slots (1, 3, 5) directly into node.data.slots,
      // each carrying a distinct steps snapshot, and set lastLoadedSlot=1 so
      // the nav anchor is deterministic. Then latch queuedNav='next' and play.
      await page.evaluate(
        ({ nodeId, type }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          const t = w.__patch.nodes[nodeId];
          if (!t) throw new Error('node missing');
          const mkSteps = (midi: number) => {
            const arr = Array.from({ length: 4 }, () =>
              type === 'sequencer' ? { on: false, midi: null, chord: 'mono' } : { on: false, midi: null, model: null },
            );
            arr[0] = type === 'sequencer' ? { on: true, midi, chord: 'mono' } : { on: true, midi, model: null };
            return arr;
          };
          w.__ydoc.transact(() => {
            if (!t.data) t.data = {};
            const d = t.data as Record<string, unknown>;
            d.slots = {
              '1': { steps: mkSteps(60), bpm: 300, length: 2 },
              '3': { steps: mkSteps(64), bpm: 300, length: 2 },
              '5': { steps: mkSteps(67), bpm: 300, length: 2 },
            };
            d.lastLoadedSlot = '1';
            d.queuedNav = 'next';
            d.queuedSlot = null;
          });
          t.params.isPlaying = 1;
        },
        { nodeId: s.nodeId, type: s.type },
      );

      // At the next sequence-end the engine should resolve NEXT over occupied
      // {1,3,5} from current=1 → slot 3.
      await expect
        .poll(
          async () =>
            await page.evaluate((nodeId) => {
              const w = globalThis as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.lastLoadedSlot;
            }, s.nodeId),
          { timeout: 8000 },
        )
        .toBe('3');

      // queuedNav must be consumed (cleared) once applied.
      const queuedNav = await page.evaluate((nodeId) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
        };
        return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.queuedNav ?? null;
      }, s.nodeId);
      expect(queuedNav).toBeFalsy();
    });

    test(`${s.type}: queued PREV from first occupied wraps to the last occupied slot`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: { isPlaying: 0, length: 2, bpm: 300 } }]);

      await page.evaluate(
        ({ nodeId, type }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          const t = w.__patch.nodes[nodeId];
          if (!t) throw new Error('node missing');
          const mkSteps = (midi: number) => {
            const arr = Array.from({ length: 4 }, () =>
              type === 'sequencer' ? { on: false, midi: null, chord: 'mono' } : { on: false, midi: null, model: null },
            );
            arr[0] = type === 'sequencer' ? { on: true, midi, chord: 'mono' } : { on: true, midi, model: null };
            return arr;
          };
          w.__ydoc.transact(() => {
            if (!t.data) t.data = {};
            const d = t.data as Record<string, unknown>;
            // occupied = {2, 6, 8}; currently on first (2) → PREV wraps to 8.
            d.slots = {
              '2': { steps: mkSteps(60), bpm: 300, length: 2 },
              '6': { steps: mkSteps(64), bpm: 300, length: 2 },
              '8': { steps: mkSteps(67), bpm: 300, length: 2 },
            };
            d.lastLoadedSlot = '2';
            d.queuedNav = 'prev';
            d.queuedSlot = null;
          });
          t.params.isPlaying = 1;
        },
        { nodeId: s.nodeId, type: s.type },
      );

      await expect
        .poll(
          async () =>
            await page.evaluate((nodeId) => {
              const w = globalThis as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.lastLoadedSlot;
            }, s.nodeId),
          { timeout: 8000 },
        )
        .toBe('8');
    });

    test(`${s.type}: queued RANDOM lands on an OCCUPIED slot`, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');
      await spawnPatch(page, [{ id: s.nodeId, type: s.type, params: { isPlaying: 0, length: 2, bpm: 300 } }]);

      await page.evaluate(
        ({ nodeId, type }) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { params: Record<string, number>; data?: Record<string, unknown> } | undefined> };
            __ydoc: { transact: (fn: () => void) => void };
          };
          const t = w.__patch.nodes[nodeId];
          if (!t) throw new Error('node missing');
          const mkSteps = (midi: number) => {
            const arr = Array.from({ length: 4 }, () =>
              type === 'sequencer' ? { on: false, midi: null, chord: 'mono' } : { on: false, midi: null, model: null },
            );
            arr[0] = type === 'sequencer' ? { on: true, midi, chord: 'mono' } : { on: true, midi, model: null };
            return arr;
          };
          w.__ydoc.transact(() => {
            if (!t.data) t.data = {};
            const d = t.data as Record<string, unknown>;
            d.slots = {
              '2': { steps: mkSteps(60), bpm: 300, length: 2 },
              '4': { steps: mkSteps(64), bpm: 300, length: 2 },
              '7': { steps: mkSteps(67), bpm: 300, length: 2 },
            };
            d.lastLoadedSlot = '4';
            d.queuedNav = 'random';
            d.queuedSlot = null;
          });
          t.params.isPlaying = 1;
        },
        { nodeId: s.nodeId, type: s.type },
      );

      // RANDOM must consume the nav (queuedNav cleared) and land on one of the
      // occupied slots {2,4,7}.
      await expect
        .poll(
          async () =>
            await page.evaluate((nodeId) => {
              const w = globalThis as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.queuedNav ?? null;
            }, s.nodeId),
          { timeout: 8000 },
        )
        .toBeFalsy();

      const landed = await page.evaluate((nodeId) => {
        const w = globalThis as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
        };
        return (w.__patch.nodes[nodeId]?.data as Record<string, unknown> | undefined)?.lastLoadedSlot;
      }, s.nodeId);
      expect(['2', '4', '7']).toContain(landed);
    });
  });
}

// ----------------------------------------------------------------------------
// Multiplayer sync — slots Y.Doc-sync across rack-mates.
// Same two-context pattern picturebox-sync.spec.ts uses (PR-73).
// ----------------------------------------------------------------------------

interface CollabContexts {
  pageA: Page;
  pageB: Page;
  rackspaceId: string;
  close: () => Promise<void>;
}

async function openTwoContexts(browser: Browser): Promise<CollabContexts> {
  const rackspaceId = `seq-tx-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  for (const p of [pageA, pageB]) {
    await p.goto('/');
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () => typeof (window as unknown as { __attachProvider?: unknown }).__attachProvider === 'function',
    );
  }
  for (const p of [pageA, pageB]) {
    await p.evaluate(async (id) => {
      const w = window as unknown as { __attachProvider: (id: string) => Promise<unknown> };
      await w.__attachProvider(id);
    }, rackspaceId);
  }
  return {
    pageA,
    pageB,
    rackspaceId,
    async close() {
      await Promise.all([ctxA.close(), ctxB.close()]);
    },
  };
}

test.describe('@collab sequencer-transport multiplayer slot sync', () => {
  // 120s ceiling: this test does THREE sequential cross-context relay
  // converges (B sees node, B sees slot, A sees loaded pattern), each on the
  // generous SYNC_BUDGET_MS backed-off poll. 60s was too tight against three
  // slow converges under CI relay contention; 120s gives full headroom
  // (matches the POLYSEQZ sibling below).
  test.setTimeout(120_000);

  test('user A saves slot 1 on a sequencer; user B sees the slot data sync over the Y.Doc', async ({
    browser,
  }) => {
    const s = await openTwoContexts(browser);
    try {
      const NODE = 'seq-collab-1';

      // A spawns a sequencer with a distinct pattern.
      await s.pageA.evaluate((nodeId) => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const steps = Array.from({ length: 32 }, () => ({ on: false, midi: null, chord: 'mono' }));
          steps[0] = { on: true, midi: 60, chord: 'mono' };
          steps[8] = { on: true, midi: 67, chord: 'mono' };
          w.__patch.nodes[nodeId] = {
            id: nodeId,
            type: 'sequencer',
            domain: 'audio',
            // x:600 clears the auto-spawned TIMELORDE (top-left 3u×2hp) so its
            // knob-row can't occlude the quicksave-slot click (#759 sizing).
            position: { x: 600, y: 200 },
            params: { isPlaying: 0, bpm: 132 },
            data: { steps },
          };
        });
      }, NODE);

      // B sees the node within a few seconds.
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate((id) => {
              const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
              return Object.keys(w.__patch.nodes).includes(id);
            }, NODE),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(true);

      // A clicks SAVE → slot 1.
      await s.pageA.locator(`[data-testid="quicksave-mode-save-${NODE}"]`).click();
      await s.pageA.locator(`[data-testid="quicksave-slot-${NODE}-1"]`).click();

      // B sees slots[1] populated within a few seconds (over the Y.Doc).
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate((id) => {
              const w = window as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              const slots = (w.__patch.nodes[id]?.data as Record<string, unknown> | undefined)?.slots as
                | Record<string, unknown>
                | undefined;
              return slots?.['1'] !== undefined && slots?.['1'] !== null;
            }, NODE),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(true);

      // B's slot 1 button should show has-data styling (local re-render after
      // the Y.Doc sync above — generous budget for a slow Svelte flush).
      await expect(
        s.pageB.locator(`[data-testid="quicksave-slot-${NODE}-1"]`),
      ).toHaveAttribute('data-has-data', 'true', { timeout: 15_000 });

      // B mutates the live pattern, then clicks LOAD → slot 1, restoring A's snapshot.
      await s.pageB.evaluate((nodeId) => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        const t = w.__patch.nodes[nodeId];
        if (!t) throw new Error('node missing on B');
        w.__ydoc.transact(() => {
          if (!t.data) t.data = {};
          (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({
            on: false,
            midi: null,
            chord: 'mono',
          }));
        });
      }, NODE);

      await s.pageB.locator(`[data-testid="quicksave-mode-load-${NODE}"]`).click();
      await s.pageB.locator(`[data-testid="quicksave-slot-${NODE}-1"]`).click();

      // A should now see the loaded pattern (because LOAD writes back to
      // node.data which Y.Doc-syncs).
      await expect
        .poll(
          async () =>
            await s.pageA.evaluate((id) => {
              const w = window as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              const steps = (w.__patch.nodes[id]?.data as Record<string, unknown> | undefined)?.steps as
                | Array<{ on: boolean; midi: number | null }>
                | undefined;
              return steps?.[0]?.on === true && steps?.[0]?.midi === 60;
            }, NODE),
          { timeout: SYNC_BUDGET_MS, intervals: SYNC_POLL_INTERVALS },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });

  // POLYSEQZ-specific collab: per-step chord data (root + quality + inversion +
  // voicing) round-trips across the wire. The base sequencer collab test above
  // exercises the {midi, on} shape; we mirror it for POLYSEQZ's richer step
  // shape so a regression in chord-aware snapshot serialization is caught.
  test('user A saves slot 1 on a POLYSEQZ; user B sees the chord-step slot data sync', async ({
    browser,
  }) => {
    // Re-enabled (wave-3, #636): runs on the dedicated @collab job (COLLAB_JOB=1,
    // with DATABASE_URL + the live relay) and the flake-check-3x lane; still
    // skipped in the sharded matrix where there's no DB/relay, matching the
    // doom-* @collab specs. The fragility flagged in the 5× purge (needed a
    // retry) was relay-propagation timing on the cross-context slot polls; those
    // are bounded expect.poll waits (raised to a 10s budget below) so a slow
    // A→relay→B converge no longer needs a Playwright retry. Proven 3× green at
    // retries=0 via flake-check-3x.
    test.skip(
      !!process.env.CI && !process.env.COLLAB_JOB,
      '@collab POLYSEQZ slot-sync needs the relay + DB — runs on the dedicated COLLAB_JOB lane, not the sharded matrix',
    );
    // FLAKE FIX: the four sequential cross-context relay polls below were 6s
    // each under the describe's 60s budget — too tight when A→relay→B converge
    // stalls under CI CPU contention (the cause of the 5× purge retry). Raise
    // each propagation poll to a 20s backed-off budget (matching the
    // in-card-title rename-sync fix) and the whole test to 120s so four slow
    // converges still fit with headroom.
    test.setTimeout(120_000);
    const s = await openTwoContexts(browser);
    try {
      const NODE = 'polyseqz-collab-1';

      // A spawns a POLYSEQZ with a distinct chord pattern.
      await s.pageA.evaluate((nodeId) => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          const steps = Array.from({ length: 32 }, () => ({
            on: false, root: 48, quality: 'maj', inversion: 0, voicing: 'closed',
          }));
          steps[0] = { on: true, root: 60, quality: 'maj7', inversion: 0, voicing: 'open' };
          steps[2] = { on: true, root: 65, quality: 'sus4', inversion: 2, voicing: 'spread' };
          w.__patch.nodes[nodeId] = {
            id: nodeId,
            type: 'polyseqz',
            domain: 'audio',
            // x:600 clears the auto-spawned TIMELORDE (top-left 3u×2hp) so its
            // knob-row can't occlude the quicksave-slot click (#759 sizing).
            position: { x: 600, y: 200 },
            params: { isPlaying: 0, bpm: 132, length: 8 },
            data: { steps },
          };
        });
      }, NODE);

      // B sees the node (cross-context relay propagation — backed-off poll).
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate((id) => {
              const w = window as unknown as { __patch: { nodes: Record<string, unknown> } };
              return Object.keys(w.__patch.nodes).includes(id);
            }, NODE),
          { timeout: 20_000, intervals: [250, 500, 1000] },
        )
        .toBe(true);

      // A clicks SAVE → slot 1. Gate on the save button being visible first so
      // a slow card mount in A's OWN DOM surfaces as a clear visible-wait
      // failure rather than a flaky click on a not-yet-rendered control.
      await expect(
        s.pageA.locator(`[data-testid="quicksave-mode-save-${NODE}"]`),
      ).toBeVisible({ timeout: 10_000 });
      await s.pageA.locator(`[data-testid="quicksave-mode-save-${NODE}"]`).click();
      await s.pageA.locator(`[data-testid="quicksave-slot-${NODE}-1"]`).click();

      // B sees slots[1] populated (cross-context relay propagation — backed-off).
      await expect
        .poll(
          async () =>
            await s.pageB.evaluate((id) => {
              const w = window as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              const slots = (w.__patch.nodes[id]?.data as Record<string, unknown> | undefined)?.slots as
                | Record<string, unknown>
                | undefined;
              return slots?.['1'] !== undefined && slots?.['1'] !== null;
            }, NODE),
          { timeout: 20_000, intervals: [250, 500, 1000] },
        )
        .toBe(true);

      // B's slot 1 button shows has-data styling (local re-render after the
      // Y.Doc sync above — generous budget for a slow Svelte flush).
      await expect(
        s.pageB.locator(`[data-testid="quicksave-slot-${NODE}-1"]`),
      ).toHaveAttribute('data-has-data', 'true', { timeout: 15_000 });

      // B mutates the live pattern, then clicks LOAD → slot 1 to restore.
      await s.pageB.evaluate((nodeId) => {
        const w = window as unknown as {
          __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        const t = w.__patch.nodes[nodeId];
        if (!t) throw new Error('node missing on B');
        w.__ydoc.transact(() => {
          if (!t.data) t.data = {};
          (t.data as Record<string, unknown>).steps = Array.from({ length: 32 }, () => ({
            on: false, root: 48, quality: 'maj', inversion: 0, voicing: 'closed',
          }));
        });
      }, NODE);

      await s.pageB.locator(`[data-testid="quicksave-mode-load-${NODE}"]`).click();
      await s.pageB.locator(`[data-testid="quicksave-slot-${NODE}-1"]`).click();

      // A should see the chord pattern restored, including quality + inversion
      // + voicing — verifying the Yjs deep-clone path doesn't drop fields.
      // Cross-context relay propagation (B's LOAD → relay → A) — backed-off poll.
      await expect
        .poll(
          async () =>
            await s.pageA.evaluate((id) => {
              const w = window as unknown as {
                __patch: { nodes: Record<string, { data?: Record<string, unknown> } | undefined> };
              };
              const steps = (w.__patch.nodes[id]?.data as Record<string, unknown> | undefined)?.steps as
                | Array<{ on: boolean; root: number | null; quality: string; inversion: number; voicing: string }>
                | undefined;
              const s0 = steps?.[0];
              const s2 = steps?.[2];
              return (
                s0?.on === true && s0.root === 60 && s0.quality === 'maj7' && s0.voicing === 'open' &&
                s2?.on === true && s2.root === 65 && s2.quality === 'sus4' && s2.inversion === 2 && s2.voicing === 'spread'
              );
            }, NODE),
          { timeout: 20_000, intervals: [250, 500, 1000] },
        )
        .toBe(true);
    } finally {
      await s.close();
    }
  });
});
