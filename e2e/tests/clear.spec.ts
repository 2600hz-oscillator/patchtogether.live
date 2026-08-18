import { test, expect, loadVoiceDemo, openFileMenu, fileMenuClick } from './_fixtures';

// ⏸ FLAKE-PARK #1847 — parked with `test.fixme`; the body and its assertions are UNCHANGED.
// NONDETERMINISM: 9 recovered-on-retry observation(s) across 9 SHA(s) / 5 branch(es) in the
// 96 h CI census to 2026-08-18 — never a hard failure, so every one of those jobs reported SUCCESS.
// LOST WHILE PARKED: that Clear actually empties the rack after the voice demo — nodes AND edges — rather than leaving orphaned edges pointing at deleted nodes.
// Re-enable only on a root cause (#1847); "it passes now" is not one.
test.fixme('clear after voice demo removes all nodes + edges', { annotation: { type: 'fixme', description: 'FLAKE-PARK #1847 — nondeterministic on CI: 9 recovered-on-retry observations in the 96 h census to 2026-08-18; parked until root-caused' } }, async ({ page, rackDefault }) => {
  // The voice demo (5 nodes / 6 edges, sequencer auto-playing).
  await loadVoiceDemo(page);
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });
  // A stereo LEG GROUP renders as ONE bezier (PR-4): the demo's
  // `vd-vca.audio → vd-out.L` + `→ R` pair is 2 edges and 1 cable, so 6
  // graph edges draw 5. Pinned in stereo-only-channel.spec.ts.
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(5);

  // Click Clear
  await fileMenuClick(page, 'workflow-file-clear');
  await page.waitForTimeout(300);

  // Assert canvas is empty
  await expect(page.locator('.svelte-flow__node')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(0);
});
