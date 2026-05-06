// Chaos Stage 1 runner.
//
// Spawns a single Chromium tab, boots the engine, drives Chaos Carl for
// CHAOS_ITERATIONS intents, checks invariants between every intent. On a
// violation: captures a finding bundle to e2e/chaos/findings/<dir>/ and
// fails the test.
//
// Configuration via env:
//   CHAOS_SEED=<int>          deterministic seed (default: time-derived)
//   CHAOS_ITERATIONS=<int>    number of intents (default 200)
//   CHAOS_PERSONALITY=<str>   currently only "carl" supported

import { test } from '@playwright/test';
import { SeededRng, defaultSeed } from './lib/seed-rng';
import { loadCatalog } from './lib/catalog';
import { ensureEngineBooted, clearPatch, applyIntent } from './lib/driver';
import { readPatch, readEngine } from './lib/state';
import { checkInvariants, type ConsoleEvent } from './lib/invariants';
import { ChaosCarl } from './lib/personalities/carl';
import { saveFinding, violationMeta } from './lib/artifact-capture';
import type { Intent } from './lib/intent';

const SEED = process.env.CHAOS_SEED ? parseInt(process.env.CHAOS_SEED, 10) : defaultSeed();
const ITERATIONS = parseInt(process.env.CHAOS_ITERATIONS ?? '200', 10);
const PERSONALITY = process.env.CHAOS_PERSONALITY ?? 'carl';

test(`chaos run [seed=${SEED}, ${ITERATIONS}× ${PERSONALITY}]`, async ({ page }) => {
  test.setTimeout(180_000);

  // eslint-disable-next-line no-console
  console.log(`[chaos] seed=${SEED} iterations=${ITERATIONS} personality=${PERSONALITY}`);

  // Console event capture. Drained per-tick so errors are attributed to the
  // iteration that produced them.
  const consoleBuffer: ConsoleEvent[] = [];
  page.on('console', (msg) => {
    consoleBuffer.push({ type: msg.type() as ConsoleEvent['type'], text: msg.text(), at: Date.now() });
  });
  page.on('pageerror', (err) => {
    consoleBuffer.push({ type: 'pageerror', text: err.message, at: Date.now() });
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await ensureEngineBooted(page);
  await clearPatch(page);

  const catalog = await loadCatalog(page);
  // eslint-disable-next-line no-console
  console.log(`[chaos] catalog loaded: ${catalog.length} modules — ${catalog.map((m) => m.type).join(', ')}`);

  const rng = new SeededRng(SEED);
  const carl = new ChaosCarl(catalog, { idPrefix: 'carl', maxOwnedNodes: 6 });
  const intentTrace: Intent[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const patchBefore = await readPatch(page);
    const intent = carl.next(rng, patchBefore);
    intentTrace.push(intent);

    await applyIntent(page, intent);

    // Tiny settle so the reconciler can apply before we read engine state.
    await page.waitForTimeout(30);

    const patchAfter = await readPatch(page);
    const engineAfter = await readEngine(page);
    const eventsThisTick = consoleBuffer.splice(0, consoleBuffer.length);

    const v = checkInvariants({
      patch: patchAfter,
      engine: engineAfter,
      consoleEvents: eventsThisTick,
      catalog,
    });

    if (v) {
      const findingDir = await saveFinding(page, {
        meta: violationMeta(v, { seed: SEED, personality: PERSONALITY, iteration: i }),
        patch: patchAfter,
        engine: engineAfter,
        consoleEvents: eventsThisTick,
        intentTrace,
      });
      // eslint-disable-next-line no-console
      console.log(`[chaos] FINDING saved: ${findingDir}`);
      throw new Error(
        `Invariant ${v.invariantId} violated at iteration ${i} (seed ${SEED}):\n` +
        `  ${v.message}\n` +
        `  artifacts: ${findingDir}\n` +
        `  replay: CHAOS_SEED=${SEED} CHAOS_ITERATIONS=${i + 1} task chaos:run`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[chaos] OK — ${ITERATIONS} intents, no invariant violations`);
});
