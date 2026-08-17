// e2e/tests/doom-session-survives-card-collapse.spec.ts
//
// #1590 (last row of the #1583 card-unmount audit) — collapsing DOOM must not
// tear down the node's game session.
//
// DoomCard's onDestroy ran `stopNetcode()` — closing every WebRTC peer
// connection and deleting `Module.PTNet` out of the RUNNING WASM — and killed
// the card rAF that was ALSO the lockstep pump (the only thing appending this
// peer's ticcmds to the shared log + draining TicSets into the WASM barrier).
// A card unmounts on COLLAPSE, on dock LRU eviction, on ESC, on M/E, on
// navigation — none of which mean the player left the game. Mid-netgame the
// result froze EVERY peer: a starved lockstep barrier PAUSES by design (#345:
// a DOOM freeze is a consistency abort), and nothing could resume it because
// the launch state (`launched`, generation, cursors) was card $state and died
// with the mount.
//
// ⚠ SCOPE — SINGLE PAGE, deliberately NOT collab-tagged. (The tag is written as
// a bare word here; that used to be load-bearing, because the collab-attest
// basis resolver regex-scanned spec CONTENT for the tag form and a comment
// alone would enrol the file. That attest was deleted 2026-08-17, so the tag now
// only routes a spec onto the `collab` lane.) A real 2-context netgame collapse
// belongs on that lane; the multi-peer netcode-survival CONTRACT is pinned by
// node-doom-session-registry.test.ts with a netcode stub. What THIS spec
// drives end-to-end in a real browser is the same session machinery on the
// single-page path: a real WASM launch, the registry pump, the session state,
// a real collapse. The probe quantities are chosen so the pre-fix teardown
// (and any future re-added lifecycle teardown) turns them red:
//
//   * `pumpRuns` — CAUSAL: counts actual session-pump invocations (units:
//     pump runs, one per frame). This is the exact mechanism whose death
//     starves every peer's barrier. Sampled IN THE PAGE across rAF FRAMES,
//     never with a Playwright-side ms poll (frames are renderer-independent;
//     a wall clock is a different number of frames on every machine).
//   * `launched` — the session state the old unmount destroyed; its survival
//     is what lets a re-expanded card show the RUNNING game.
//   * `gametic` — engine truth that the WASM (engine-owned, never card-owned)
//     keeps simulating while no card exists. Green pre-fix too — it anchors
//     "the game is really running", it is not the discriminator.
//
// The probe is `__nodeDoomSession` (Canvas) — the NODE's own record plus live
// engine readings, never a card's state: the card is the thing under test for
// being absent.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const NODE = 'd';

test.setTimeout(150_000);

interface DoomProbe {
  hasEntry: boolean;
  wired: boolean;
  pumpRuns: number;
  netStarted: boolean;
  launched: boolean;
  lockstepActive: boolean;
  runtimeInitialized?: boolean;
  gametic?: number;
  gamestate?: number;
  ptnetBound?: boolean;
  lastLaunch?: { launchId: number; map: number } | null;
}

/** The NODE's own view of its session — deliberately not read off the card. */
async function probe(page: Page): Promise<DoomProbe> {
  return page.evaluate(
    (n) => (globalThis as unknown as { __nodeDoomSession(x: string): DoomProbe }).__nodeDoomSession(n),
    NODE,
  );
}

/**
 * Wait until probe field `field` advances by `minAdvance`, accumulating IN THE
 * PAGE across rAF FRAMES (never a Playwright-side ms poll — a loaded runner
 * starves both subject and sampler, and "frozen" vs "never looked" become
 * indistinguishable). Returns first/last/frames plus the distinct values seen
 * so a failure message can tell those apart.
 */
async function fieldAdvance(page: Page, field: 'pumpRuns' | 'gametic', minAdvance: number, maxFrames: number) {
  return page.evaluate(
    async ({ n, field, minAdvance, maxFrames }) => {
      const api = (globalThis as unknown as { __nodeDoomSession(x: string): Record<string, number> })
        .__nodeDoomSession;
      const first = api(n)[field] ?? -1;
      const seen: number[] = [first];
      let frames = 0;
      let last = first;
      while (frames < maxFrames) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        frames++;
        last = api(n)[field] ?? -1;
        if (seen[seen.length - 1] !== last) seen.push(last);
        if (last - first >= minAdvance) break;
      }
      return { first, last, advanced: last - first, frames, distinct: seen.length, seen: seen.slice(-6) };
    },
    { n: NODE, field, minAdvance, maxFrames },
  );
}

async function openDoomCard(page: Page) {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    NODE,
  );
  await expect(page.getByTestId('doom-card')).toBeVisible({ timeout: 20_000 });
}

test('a RUNNING DOOM session SURVIVES its card being collapsed — and the graph still releases it', async ({
  page,
}) => {
  await page.goto('/rack?seed=none');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });

  // Pre-flight: the WASM shim + shareware WAD must be on the dev server, or
  // this spec cannot test what it is for (same diagnostic as doom-wasm.spec).
  const wasmShim = await page.request.get('/doom/doom.js');
  expect(
    wasmShim.ok(),
    `DOOM WASM shim not on dev server (status ${wasmShim.status()}). ` +
      `Run \`bash packages/web/native/build-doom-wasm.sh\`, or check the ` +
      `"Build DOOM WASM (emcc)" CI step.`,
  ).toBe(true);
  const wad = await page.request.get('/doom/DOOM1.WAD');
  expect(
    wad.ok(),
    `DOOM1.WAD not on dev server (status ${wad.status()}). ` +
      `See packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md.`,
  ).toBe(true);

  // DOOM → VIDEO OUT, so the engine's render graph demonstrably consumes the
  // surface while no card exists (the WASM tick rides the engine draw).
  await spawnPatch(
    page,
    [
      { id: NODE, type: 'doom', position: { x: 160, y: 140 }, domain: 'video' },
      { id: 'vo', type: 'videoOut', position: { x: 620, y: 140 }, domain: 'video' },
    ],
    [
      {
        id: 'e_dv',
        from: { nodeId: NODE, portId: 'out' },
        to: { nodeId: 'vo', portId: 'in' },
        sourceType: 'video',
        targetType: 'video',
      },
    ],
    { mountTimeout: 40_000 },
  );

  // ── ARRANGE: boot the WASM through the real card control, then drive the
  // seat + launch through the same __doomCards hooks the doom suite uses.
  // Lone-page path: the host seats itself at slot 0 and launches a 1-player
  // netgame (no netcode/lockstep — memberIds ≤ 1), entering GS_LEVEL. ──
  await openDoomCard(page);
  const card = page.getByTestId('doom-card');
  const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
  await expect(loadBtn, 'load-overlay button visible before click').toBeVisible({ timeout: 15_000 });
  await loadBtn.click();
  await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, { timeout: 30_000 });

  await page.evaluate(async (n) => {
    const cards = (globalThis as unknown as {
      __doomCards: Record<string, { join(): Promise<void> }>;
    }).__doomCards;
    await cards[n]!.join();
  }, NODE);
  await expect
    .poll(
      async () =>
        page.evaluate(
          (n) =>
            (globalThis as unknown as {
              __doomCards: Record<string, { getState(): { mySlot: number | null } }>;
            }).__doomCards[n]!.getState().mySlot,
          NODE,
        ),
      { message: 'the lone host never seated itself at slot 0 — the ARRANGE is broken, not the fix', timeout: 15_000 },
    )
    .toBe(0);
  await page.evaluate((n) => {
    (globalThis as unknown as {
      __doomCards: Record<string, { launch(): void }>;
    }).__doomCards[n]!.launch();
  }, NODE);

  await expect
    .poll(async () => JSON.stringify(await probe(page)), {
      message:
        'the launch never entered GS_LEVEL (gamestate 0) with launched=true — ' +
        'the ARRANGE is broken, not the fix. Probe printed for triage.',
      timeout: 30_000,
    })
    .toContain('"launched":true');
  await expect
    .poll(async () => (await probe(page)).gamestate, {
      message: 'gamestate never reached GS_LEVEL (0) after launch (units: DOOM gamestate_t ordinal)',
      timeout: 30_000,
    })
    .toBe(0);

  // Instrument positive control: the pump must demonstrably advance WITH the
  // card mounted, or a green "advances while collapsed" leg later would be
  // unfalsifiable.
  const pumpBefore = await fieldAdvance(page, 'pumpRuns', 5, 300);
  expect(
    pumpBefore.advanced,
    `the session pump did not advance even WITH the card mounted ` +
      `(units: pump runs over rAF frames): ${JSON.stringify(pumpBefore)}`,
  ).toBeGreaterThanOrEqual(5);

  // ── ACT: collapse. This UNMOUNTS DoomCard (doom is in no headless-mount
  // lane set — the card is genuinely destroyed). ──
  await page.getByTestId('faceplate-collapse').click();
  await expect(page.getByTestId('doom-card')).toHaveCount(0, { timeout: 15_000 });

  // ── ASSERT 1: the session state survived. This is the whole regression. ──
  const afterCollapse = await probe(page);
  expect(
    afterCollapse.launched,
    `the collapse DESTROYED the launch state — this is the #1590 defect ` +
      `(a re-expanded card comes up idle over a running game; in a netgame every ` +
      `peer freezes, #345 semantics). probe=${JSON.stringify(afterCollapse)}`,
  ).toBe(true);
  expect(afterCollapse.hasEntry).toBe(true);
  expect(
    afterCollapse.wired,
    `the node lost its session wiring on collapse: ${JSON.stringify(afterCollapse)}`,
  ).toBe(true);

  // ── ASSERT 2 (CAUSAL): the session pump keeps RUNNING while the card is
  // gone. In a netgame this pump is what feeds every peer's barrier; its
  // death here IS the freeze. Frames, not milliseconds. ──
  const pumpWhileCollapsed = await fieldAdvance(page, 'pumpRuns', 10, 600);
  expect(
    pumpWhileCollapsed.advanced,
    `the session pump FROZE once the card was collapsed (units: pump runs over ` +
      `${pumpWhileCollapsed.frames} rAF frames; distinct values seen ${pumpWhileCollapsed.distinct}, ` +
      `last ${JSON.stringify(pumpWhileCollapsed.seen)}) — in a netgame this starves every ` +
      `peer's lockstep barrier (#345). This is the #1590 regression.`,
  ).toBeGreaterThanOrEqual(10);

  // ── ASSERT 3 (anchor): the WASM keeps simulating (engine-owned; green even
  // pre-fix — it anchors that a real game is running while no card exists,
  // it is not the discriminator). ──
  const ticsWhileCollapsed = await fieldAdvance(page, 'gametic', 3, 600);
  expect(
    ticsWhileCollapsed.advanced,
    `gametic stopped advancing while collapsed (units: engine tics over ` +
      `${ticsWhileCollapsed.frames} rAF frames): ${JSON.stringify(ticsWhileCollapsed)} — ` +
      `the WASM is engine-owned and must keep simulating without a card`,
  ).toBeGreaterThanOrEqual(3);

  // …and the session state is STILL intact after those sampling windows — a
  // teardown scheduled by the unmount (queued microtask, deferred effect
  // cleanup) would land after the synchronous checks above and read as a pass.
  const later = await probe(page);
  expect(
    later.launched && later.wired,
    `a DEFERRED teardown dismantled the session shortly after the collapse: ${JSON.stringify(later)}`,
  ).toBe(true);

  // ── Re-expanding ADOPTS the running session, not a fresh idle card. ──
  await openDoomCard(page);
  const cardAgain = page.getByTestId('doom-card');
  await expect(
    cardAgain.locator('button.overlay').filter({ hasText: 'Click to load DOOM' }),
    're-expanding showed the LOAD button over a RUNNING game — the remounted card ' +
      'failed to adopt the live session (pre-#1590 behaviour: black canvas + load overlay)',
  ).toHaveCount(0);
  const adopted = await page.evaluate(
    (n) =>
      (globalThis as unknown as {
        __doomCards: Record<string, { getState(): { launched: boolean; mySlot: number | null } }>;
      }).__doomCards[n]!.getState(),
    NODE,
  );
  expect(
    adopted.launched,
    `the remounted card does not read the session's launch state: ${JSON.stringify(adopted)}`,
  ).toBe(true);
  expect(adopted.mySlot, 'the remounted card recovered its seat from the synced roster').toBe(0);

  // ── POSITIVE CONTROL, and it is load-bearing: teardown must still be
  // POSSIBLE. Deleting the node from the graph (the sweep's event) must end
  // the session — a registry that never releases would green every assertion
  // above while leaking netgames for the life of the tab. ──
  await page.evaluate((n) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      delete w.__patch.nodes[n];
    });
  }, NODE);

  await expect
    .poll(async () => (await probe(page)).hasEntry, {
      message:
        'deleting the node did NOT release its session — the sweep is not reaching ' +
        'the doom registry, and every "survives collapse" assertion above is vacuous',
      timeout: 15_000,
    })
    .toBe(false);
  // The pump loop died with the entry: the probe reports the sentinel, twice
  // (a still-scheduled loop would re-create measurable state between reads).
  expect((await probe(page)).pumpRuns).toBe(-1);
  await page.waitForTimeout(250); // bound-the-failure cap only, not the gate
  expect((await probe(page)).pumpRuns).toBe(-1);
});
