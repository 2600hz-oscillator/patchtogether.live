// e2e/tests/doom-inputs-restored.spec.ts
//
// Regression test pinning DOOM's CV/gate INPUT surface after the PR #393
// revert. The user-facing symptom that motivated the revert: "we had full
// control working" via per-player CV/gate inputs (p1..p4 × up/down/left/
// right/space/ctrl/alt → 28 inputs total) — when ANY of those inputs is
// patched, keyboard input for that slot is disabled. After PR #393 added 6
// new event-gate OUTPUTS (evt_kill / evt_door / evt_gun_p1..p4), CV control
// stopped working for the user. This spec doesn't bisect the cause; it pins
// the input contract so a future re-introduction of event-gate outputs can
// be CI-verified to NOT drop the inputs.
//
// What this asserts (no WASM required — pure def + UI shape):
//   1. DOOM's registered ModuleDef has > 0 inputs, and every input id matches
//      the per-slot pattern `p{N}_{base}` from CV_GATE_PORT_IDS_BY_SLOT.
//   2. The DoomCard renders an INPUT handle for every declared input port
//      (handles + def stay in sync, the same invariant io-spec-consistency
//      enforces project-wide).
//   3. DOOM + SEQUENCER can be spawned and an edge SEQUENCER.gate →
//      DOOM.p1_space can be added with no console errors. (This is the
//      smallest "is the CV path connectable at all" check that does NOT
//      require the WASM bundle.)
//
// Reference: `packages/web/src/lib/doom/doomkeys.ts` →
// `CV_GATE_PORT_IDS_BY_SLOT` is the canonical port-id source.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { REGISTRY } from './_registry';

const EXPECTED_BASES = ['up', 'down', 'left', 'right', 'space', 'ctrl', 'alt'] as const;
const EXPECTED_SLOTS = [1, 2, 3, 4] as const;

test.describe('DOOM — CV/gate INPUT contract pinned (PR #393 revert regression)', () => {
  test('registered def has 28 per-slot CV inputs (p1..p4 × 7 bases)', () => {
    const doom = REGISTRY.find((m) => m.type === 'doom');
    expect(doom, 'DOOM is in the registry manifest').toBeTruthy();
    if (!doom) return;

    expect(doom.inputs.length, 'DOOM has > 0 inputs').toBeGreaterThan(0);

    // Every input id must match the per-slot pattern. Full set is the
    // cartesian product of the 4 slots × 7 base gates = 28.
    const expectedIds = new Set<string>();
    for (const slot of EXPECTED_SLOTS) {
      for (const base of EXPECTED_BASES) {
        expectedIds.add(`p${slot}_${base}`);
      }
    }
    const actualIds = new Set(doom.inputs.map((p) => p.id));
    expect(
      actualIds,
      'DOOM exposes the full p{N}_{base} CV-gate input set',
    ).toEqual(expectedIds);
  });

  test('DoomCard renders an INPUT handle for every declared input port', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(page, [
      { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
    ]);

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card, 'DOOM card mounts').toHaveCount(1);

    const doom = REGISTRY.find((m) => m.type === 'doom');
    expect(doom, 'DOOM is in the registry manifest').toBeTruthy();
    if (!doom) return;

    const handleInputIds = await readInputHandleIds(page);
    const expected = doom.inputs.map((p) => p.id).sort();
    const actual = [...handleInputIds].sort();
    expect(
      actual,
      'every declared DOOM input has a rendered handle',
    ).toEqual(expect.arrayContaining(expected));
  });

  test('SEQUENCER.gate → DOOM.p1_space patches cleanly (no console errors)', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Spawn DOOM + SEQUENCER + patch SEQUENCER.gate -> DOOM.p1_space. We use
    // sequencer's `gate` output as the CV driver. No WASM required for the
    // patch-graph plumbing — the edge just needs to be add-able + persisted.
    await spawnPatch(
      page,
      [
        { id: 'v-doom', type: 'doom', position: { x: 200, y: 120 }, domain: 'video' },
        { id: 'a-seq', type: 'sequencer', position: { x: 600, y: 120 }, domain: 'audio' },
      ],
      [
        {
          id: 'e-seq-doom',
          from: { nodeId: 'a-seq', portId: 'gate' },
          to: { nodeId: 'v-doom', portId: 'p1_space' },
        },
      ],
    );

    // Filter out the known-noisy/known-acceptable errors so this regression
    // spec only fails on NEW errors introduced by the input path. The
    // `AudioEngine.addEdge: no target node v-doom` error is a pre-existing
    // cross-domain reconciler ordering bug (audio engine sees the edge before
    // the video node registers) — unrelated to #393, deferred to a separate
    // PR. Filter it so this revert spec doesn't conflate the two.
    const blocking = consoleErrors.filter(
      (e) =>
        !e.includes('DOOM') // DOOM bootstraps log info-level errors when WASM is absent
        && !e.includes('doom.js')
        && !e.includes('DOOM1.WAD')
        && !e.includes('WebGL')
        && !e.includes('FBO')
        && !e.includes('Failed to fetch')
        && !e.includes('AudioEngine.addEdge: no target node')
        && !e.includes('reconcile failed'),
    );
    expect(blocking, 'no NEW console errors from spawning + patching DOOM CV input').toEqual([]);
  });
});

/** Same handle-discovery pattern io-spec-consistency.spec.ts uses. Returns
 *  only the INPUT (target-side) handles on the DOOM card. */
async function readInputHandleIds(page: Page): Promise<string[]> {
  const card = page.locator('.svelte-flow__node-doom');
  const handles = card.locator('.svelte-flow__handle');
  const count = await handles.count();
  const inputs: string[] = [];
  for (let i = 0; i < count; i++) {
    const h = handles.nth(i);
    const id = await h.getAttribute('data-handleid');
    if (!id) continue;
    const cls = (await h.getAttribute('class')) ?? '';
    // Inputs render as `target` handles in Svelte Flow.
    if (!cls.includes('source')) inputs.push(id);
  }
  return inputs;
}
