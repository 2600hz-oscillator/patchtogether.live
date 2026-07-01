// e2e/vrt/groups.spec.ts
//
// Group/instrument state VRT. Captures the GROUP! card under two distinct
// configurations that the per-module vrt.spec.ts can't reach (the `group`
// type is EXEMPT_FROM_VRT there — bare chrome with no exposed ports has no
// module-specific pixels to fingerprint; you need to populate exposedPorts
// to get a useful baseline):
//
//   - group-bare           → GROUP! card with zero exposed jacks (chrome
//                            + label only, no port rows)
//   - group-with-exposed   → GROUP! card with one input + one output
//                            exposed (osc cv input + filter audio output —
//                            the canonical pattern)
//
// Spawned via the dev __ydoc / __patch globals same as the other VRT
// specs. Exemptions follow the same pattern as interactions.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const EXEMPT_BASELINE_PAIRS = new Set<string>([
  'linux/group-bare',
  'linux/group-with-exposed',
]);
const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

function skipIfNoBaseline(t: typeof test, name: string): void {
  t.skip(
    EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${name}`),
    `${name} on ${VRT_PLATFORM}: baseline pending (CI capture follow-up)`,
  );
}

async function hideJitterers(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      .cursor, .awareness-cursor, .selection-rect { display: none !important; }
      .feedback-bug { display: none !important; }
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `,
  });
}

async function bootCanvas(page: Page): Promise<void> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await hideJitterers(page);
}

/** Spawn a 2-child group (analogVco + filter) wrapped in a group node.
 *  `exposed: 'none'` ships zero exposed jacks (bare chrome shot).
 *  `exposed: 'osc-filter'` exposes the vco's `cv` input and the filter's
 *  `audio` output — the classic one-in/one-out pattern. */
async function spawnGroup(
  page: Page,
  { exposed }: { exposed: 'none' | 'osc-filter' },
): Promise<void> {
  await spawnPatch(page, [
    { id: 'g-vco', type: 'analogVco', position: { x: 80, y: 80 } },
    { id: 'g-flt', type: 'filter', position: { x: 320, y: 80 } },
  ]);

  await page.evaluate(
    ({ exposed: which }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, Record<string, unknown>>;
          edges: Record<string, unknown>;
        };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const groupId = 'g-vrt';
      const exposedPorts =
        which === 'osc-filter'
          ? [
              {
                id: 'in--g-vco--cv',
                childId: 'g-vco',
                childPortId: 'cv',
                direction: 'input',
                cableType: 'cv',
              },
              {
                id: 'out--g-flt--audio',
                childId: 'g-flt',
                childPortId: 'audio',
                direction: 'output',
                cableType: 'audio',
              },
            ]
          : [];
      w.__ydoc.transact(() => {
        w.__patch.nodes[groupId] = {
          id: groupId,
          type: 'group',
          domain: 'meta',
          position: { x: 200, y: 240 },
          params: {},
          data: {
            childIds: ['g-vco', 'g-flt'],
            exposedPorts,
            label: which === 'none' ? 'GROUP!' : 'OSC+FLT',
          },
        };
        for (const cid of ['g-vco', 'g-flt']) {
          const n = w.__patch.nodes[cid];
          if (n) {
            if (!n.data) n.data = {};
            (n.data as { parentGroupId?: string }).parentGroupId = groupId;
          }
        }
      });
    },
    { exposed },
  );

  await page
    .locator('[data-testid="group-card"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe.configure({ mode: 'default' });

test('group-bare: GROUP! card with no exposed jacks', async ({ page }) => {
  skipIfNoBaseline(test, 'group-bare');
  await bootCanvas(page);
  await spawnGroup(page, { exposed: 'none' });
  const card = page.locator('[data-testid="group-card"]').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(card).toHaveScreenshot('group-bare.png');
});

test('group-with-exposed: GROUP! card with exposed osc+filter jacks', async ({ page }) => {
  skipIfNoBaseline(test, 'group-with-exposed');
  await bootCanvas(page);
  await spawnGroup(page, { exposed: 'osc-filter' });
  const card = page.locator('[data-testid="group-card"]').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(card).toHaveScreenshot('group-with-exposed.png');
});
