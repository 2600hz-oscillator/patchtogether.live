// Chaos Stage 1 runner.
//
// Spawns a single Chromium tab, boots the engine, drives Chaos Carl for
// CHAOS_ITERATIONS intents, checks invariants between every intent. On a
// violation: captures a finding bundle to e2e/chaos/findings/<dir>/ and
// fails the test.
//
// Configuration via env:
//   CHAOS_SEED=<int>            deterministic seed (default: time-derived)
//   CHAOS_ITERATIONS=<int>      number of intents (default 200)
//   CHAOS_PERSONALITY=<str>     currently only "carl" supported
//   CHAOS_MAX_NODES=<int>       per-bot module cap (default 6). Prevents the
//                               bot from filling a shared rackspace with junk.
//   CHAOS_RACKSPACE_URL=<url>   absolute URL the bot navigates to instead of
//                               '/'. Use the invite link form
//                               (https://host/r/<id>?invite=<code>) so the
//                               bot joins as an anon participant and Canvas
//                               actually mounts (hooks aren't exposed on '/').

import { test } from '@playwright/test';
import { SeededRng, defaultSeed } from './lib/seed-rng';
import { loadCatalog } from './lib/catalog';
import { ensureEngineBooted, clearPatch, applyIntent, organizeModules } from './lib/driver';
import { readPatch, readEngine } from './lib/state';
import { checkInvariants, type ConsoleEvent } from './lib/invariants';
import { ChaosCarl } from './lib/personalities/carl';
import { saveFinding, violationMeta } from './lib/artifact-capture';
import type { Intent } from './lib/intent';

const SEED = process.env.CHAOS_SEED ? parseInt(process.env.CHAOS_SEED, 10) : defaultSeed();
const ITERATIONS = parseInt(process.env.CHAOS_ITERATIONS ?? '200', 10);
const PERSONALITY = process.env.CHAOS_PERSONALITY ?? 'carl';
const MAX_NODES = parseInt(process.env.CHAOS_MAX_NODES ?? '6', 10);
const RACKSPACE_URL = process.env.CHAOS_RACKSPACE_URL;

// Pacing: after each addNode the runner sleeps SPAWN_GAP_MIN_MS..MAX_MS
// (default 2..3s) and triggers the canvas's Organize-modules layout pass.
// This keeps the bot from filling a shared rackspace faster than humans
// can react and keeps the layout legible for any observers / recordings.
const SPAWN_GAP_MIN_MS = parseInt(process.env.CHAOS_SPAWN_GAP_MIN_MS ?? '2000', 10);
const SPAWN_GAP_MAX_MS = parseInt(process.env.CHAOS_SPAWN_GAP_MAX_MS ?? '3000', 10);

test(`chaos run [seed=${SEED}, ${ITERATIONS}× ${PERSONALITY}]`, async ({ page }) => {
  // Pacing adds ~2.5s per addNode; bump default timeout so longer runs
  // don't get artificially killed mid-iteration.
  const expectedMaxSpawnGapMs = ITERATIONS * SPAWN_GAP_MAX_MS;
  test.setTimeout(Math.max(180_000, expectedMaxSpawnGapMs + 60_000));

  // eslint-disable-next-line no-console
  console.log(
    `[chaos] seed=${SEED} iterations=${ITERATIONS} personality=${PERSONALITY} ` +
      `maxNodes=${MAX_NODES} target=${RACKSPACE_URL ?? '/'}`,
  );

  // Console event capture. Drained per-tick so errors are attributed to the
  // iteration that produced them.
  const consoleBuffer: ConsoleEvent[] = [];
  page.on('console', (msg) => {
    consoleBuffer.push({ type: msg.type() as ConsoleEvent['type'], text: msg.text(), at: Date.now() });
  });
  page.on('pageerror', (err) => {
    consoleBuffer.push({ type: 'pageerror', text: err.message, at: Date.now() });
  });

  await page.goto(RACKSPACE_URL ?? '/');
  await page.waitForLoadState('networkidle');
  await ensureEngineBooted(page);
  // Shared rackspaces must not be wiped — only clear in solo mode where the
  // bot owns the patch end-to-end.
  if (!RACKSPACE_URL) await clearPatch(page);

  const catalog = await loadCatalog(page);
  // eslint-disable-next-line no-console
  console.log(`[chaos] catalog loaded: ${catalog.length} modules — ${catalog.map((m) => m.type).join(', ')}`);

  const rng = new SeededRng(SEED);
  const carl = new ChaosCarl(catalog, { idPrefix: 'carl', maxOwnedNodes: MAX_NODES });
  const intentTrace: Intent[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const patchBefore = await readPatch(page);
    const intent = carl.next(rng, patchBefore);
    intentTrace.push(intent);

    await applyIntent(page, intent);

    // After a new module appears, give the layout pass a moment and then
    // tidy the canvas so the bot doesn't pile modules on top of each
    // other. Pacing also throttles total spawn rate so the runner feels
    // closer to a human-paced patcher than a fuzzer.
    if (intent.kind === 'addNode') {
      // Tiny settle for the engine reconciler before invoking organize
      // (organize reads node bounding boxes; the card needs to mount).
      await page.waitForTimeout(120);
      await organizeModules(page);
      await page.waitForTimeout(rng.int(SPAWN_GAP_MIN_MS, SPAWN_GAP_MAX_MS));
    } else {
      // Tiny settle so the reconciler can apply before we read engine state.
      await page.waitForTimeout(30);
    }

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
