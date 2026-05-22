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
//   CHAOS_INFINITE=1            ignore CHAOS_ITERATIONS and loop forever
//                               (until killed). Implies log-only invariants
//                               so a single finding doesn't stop the show.

import { test } from '@playwright/test';
import { SeededRng, defaultSeed } from './lib/seed-rng';
import { loadCatalog } from './lib/catalog';
import { ensureEngineBooted, clearPatch, applyIntent } from './lib/driver';
import { readPatch, readEngine } from './lib/state';
import { checkInvariants, type ConsoleEvent } from './lib/invariants';
import { ChaosCarl } from './lib/personalities/carl';
import { saveFinding, violationMeta } from './lib/artifact-capture';
import type { Intent } from './lib/intent';

const ITERATIONS = parseInt(process.env.CHAOS_ITERATIONS ?? '200', 10);
const PERSONALITY = process.env.CHAOS_PERSONALITY ?? 'carl';
const MAX_NODES = parseInt(process.env.CHAOS_MAX_NODES ?? '6', 10);
const RACKSPACE_URL = process.env.CHAOS_RACKSPACE_URL;
const INFINITE = process.env.CHAOS_INFINITE === '1';
// In shared-rack mode invariants are "findings, not failures": the engine
// reconciler can legitimately lag the Yjs doc across clients, so the solo-mode
// "patch must equal engine" checks fire false positives. Same when INFINITE is
// requested — a single finding shouldn't stop the show.
const LOG_ONLY_INVARIANTS = Boolean(RACKSPACE_URL) || INFINITE;

// Title is intentionally stable. Earlier versions embedded the seed in the
// title, but Playwright discovers tests in the parent process and runs them
// in a separate worker process — when CHAOS_SEED is unset, defaultSeed()
// returns a different value in each, the titles diverge, and the worker
// errors out with "Test not found in the worker process." Seed is logged
// and surfaced via test annotations below.
test('chaos run', async ({ page }, testInfo) => {
  const SEED = process.env.CHAOS_SEED ? parseInt(process.env.CHAOS_SEED, 10) : defaultSeed();
  testInfo.annotations.push({ type: 'seed', description: String(SEED) });
  testInfo.annotations.push({ type: 'personality', description: PERSONALITY });
  testInfo.annotations.push({
    type: 'iterations',
    description: INFINITE ? '∞' : String(ITERATIONS),
  });
  // No upper bound in INFINITE mode — Playwright's 0 disables the timeout.
  test.setTimeout(INFINITE ? 0 : 180_000);

  // eslint-disable-next-line no-console
  console.log(
    `[chaos] seed=${SEED} iterations=${INFINITE ? '∞' : ITERATIONS} personality=${PERSONALITY} ` +
      `maxNodes=${MAX_NODES} target=${RACKSPACE_URL ?? '/'} ` +
      `invariants=${LOG_ONLY_INVARIANTS ? 'log-only' : 'fail-fast'}`,
  );

  // Console event capture. Drained per-tick so errors are attributed to the
  // iteration that produced them.
  //
  // Issue #146 fix: capture err.stack/err.name on pageerror, and pull
  // msg.location() on console-error events. Without this enrichment, raw
  // ErrorEvent dispatches (typical of AudioWorklet failures) reach the
  // invariant as the literal string "ErrorEvent" and the finding bundle
  // is useless for triage.
  const consoleBuffer: ConsoleEvent[] = [];
  page.on('console', (msg) => {
    const type = msg.type() as ConsoleEvent['type'];
    let stack: string | undefined;
    if (type === 'error') {
      // Playwright doesn't expose the in-page JS stack on console.error
      // events, but msg.location() carries "${url}:${line}:${col}" which
      // beats no provenance at all. We synthesize a one-line "stack" so
      // findings can be grouped by source location.
      const loc = msg.location();
      if (loc?.url) stack = `at ${loc.url}:${loc.lineNumber ?? '?'}:${loc.columnNumber ?? '?'}`;
    }
    consoleBuffer.push({ type, text: msg.text(), at: Date.now(), stack });
  });
  page.on('pageerror', (err) => {
    // For bare ErrorEvent dispatches (no Error instance underneath),
    // err.message is the constructor name — combine name + message so the
    // captured text is always non-empty.
    const text = err.message && err.message !== 'ErrorEvent'
      ? err.message
      : `${err.name ?? 'Error'}: ${err.message ?? '(no message)'}`;
    consoleBuffer.push({
      type: 'pageerror',
      text,
      at: Date.now(),
      name: err.name,
      stack: err.stack,
    });
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

  // In shared-rack mode, plant an audioOut so Carl's random edge picks have a
  // sink to terminate on. Carl himself never spawns audioOut (singleton sink,
  // see catalog NEVER_SPAWN), but he WILL route TO any existing audioOut —
  // so the bot's vco→mixer→audioOut chains emerge naturally.
  if (RACKSPACE_URL) {
    await applyIntent(page, { kind: 'addNode', id: 'carl-audioOut', type: 'audioOut' });
    // eslint-disable-next-line no-console
    console.log('[chaos] pre-spawned carl-audioOut as chain sink');
  }

  const rng = new SeededRng(SEED);
  const carl = new ChaosCarl(catalog, { idPrefix: 'carl', maxOwnedNodes: MAX_NODES });
  const intentTrace: Intent[] = [];

  let findings = 0;
  for (let i = 0; INFINITE || i < ITERATIONS; i++) {
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
      findings++;
      const findingDir = await saveFinding(page, {
        meta: violationMeta(v, { seed: SEED, personality: PERSONALITY, iteration: i }),
        patch: patchAfter,
        engine: engineAfter,
        consoleEvents: eventsThisTick,
        intentTrace,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[chaos] FINDING #${findings} at iter ${i}: ${v.invariantId} — ${v.message} (${findingDir})`,
      );
      if (!LOG_ONLY_INVARIANTS) {
        throw new Error(
          `Invariant ${v.invariantId} violated at iteration ${i} (seed ${SEED}):\n` +
          `  ${v.message}\n` +
          `  artifacts: ${findingDir}\n` +
          `  replay: CHAOS_SEED=${SEED} CHAOS_ITERATIONS=${i + 1} task chaos:run`,
        );
      }
    }

    // Heartbeat every 50 iters in long runs so the operator knows it's alive.
    if (INFINITE && i > 0 && i % 50 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[chaos] iter ${i} — ${patchAfter.nodes.length} nodes, ${patchAfter.edges.length} edges, ${findings} findings so far`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[chaos] OK — ${ITERATIONS} intents, ${findings} finding(s)`);
});
