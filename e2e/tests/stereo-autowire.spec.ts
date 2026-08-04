// e2e/tests/stereo-autowire.spec.ts
//
// WORKSTREAM A item 6 — module-wide stereo L/R auto-wire.
//
// Behaviour: patching L (or R) of a stereo SOURCE into a stereo-accepting
// TARGET whose sibling input is currently UNPATCHED auto-wires the OTHER side
// too — in ONE action. Decided defaults exercised here:
//   * BOTH source + target must declare a matching stereoPairs sibling
//     (out_l→in_l implies out_r→in_r), else no auto-wire.
//   * a MONO source into a stereo target's L leaves the sibling UNPATCHED —
//     and the target's OWN DSP normals R←L, so its right output still speaks.
//     (The engine normals NOTHING; that claim used to sit here and was false.
//     See stereo-mono-normal.spec.ts.)
//   * skip if the sibling target input is already occupied (no overwrite).
//   * naming-agnostic — resolved via stereoPairs tuples, not name patterns
//     (rings odd/even, cofefve inL/inR, charlottes-echos L/R).
//
// These drive the REAL redesigned "patch to" commit path (open the source
// menu → drill OUTPUT → jack-click the source output ROW (carry) → "patch
// to" → pick the target module → pick the target INPUT port →
// pickPortMenuTarget → writeStereoSiblingEdge), so they assert the WIRED
// commit site through a real user gesture, not just the pure planner (which
// is unit-tested in stereo-autowire.test.ts).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface PatchEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

async function readEdges(page: Page): Promise<PatchEdge[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __patch: { edges: Record<string, PatchEdge> } };
    return Object.values(w.__patch.edges).filter(Boolean) as PatchEdge[];
  });
}

function hasEdge(edges: PatchEdge[], from: [string, string], to: [string, string]): boolean {
  return edges.some(
    (e) =>
      e.source.nodeId === from[0] &&
      e.source.portId === from[1] &&
      e.target.nodeId === to[0] &&
      e.target.portId === to[1],
  );
}

function chrome(page: Page, nodeId: string) {
  return page.locator(`[data-patch-panel-chrome="${nodeId}"]`);
}

async function openMenu(page: Page, nodeId: string) {
  await page
    .locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="patch-trigger"]`)
    .click();
  await expect(chrome(page, nodeId)).toHaveAttribute('aria-hidden', 'false');
}

/** Drive the REAL redesigned commit: carry a SOURCE output port (jack-click
 *  the OUTPUT row), open the "patch to" picker, pick the target module + its
 *  INPUT port — committing via pickPortMenuTarget (the wired stereo-autowire
 *  commit site). */
async function cascadePatch(
  page: Page,
  src: { nodeId: string; portId: string },
  dst: { nodeId: string; portId: string },
) {
  await openMenu(page, src.nodeId);
  await chrome(page, src.nodeId)
    .locator('[data-testid="patch-panel-nav"][data-nav="outputs"]')
    .click();
  await chrome(page, src.nodeId)
    .locator(`[data-testid="patch-panel-port-row"][data-port-id="${src.portId}"]`)
    .click();
  await page.mouse.move(500, 320);
  await chrome(page, src.nodeId).locator('[data-testid="patch-panel-patch-to"]').click();
  const menu = page.locator('[data-testid="port-context-menu"]');
  await expect(menu).toBeVisible();

  await menu.locator(`[data-testid="patch-to-module"][data-node-id="${dst.nodeId}"]`).click();
  const portRow = menu.locator(`[data-testid="patch-to-port"][data-port-id="${dst.portId}"]`);
  await expect(portRow).toBeVisible();
  await portRow.click();
  await expect(menu).toHaveCount(0);
}

test.describe('stereo L/R auto-wire', () => {
  test('stereo source L → stereo target L auto-wires R too (rings odd/even → cofefve inL/inR)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'rings', type: 'rings', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    // Patch the L side only: rings.odd → cofefve.inL.
    await cascadePatch(page, { nodeId: 'rings', portId: 'odd' }, { nodeId: 'coco', portId: 'inL' });

    // BOTH edges must materialize from the single action.
    await expect
      .poll(async () => {
        const edges = await readEdges(page);
        return hasEdge(edges, ['rings', 'odd'], ['coco', 'inL']) && hasEdge(edges, ['rings', 'even'], ['coco', 'inR']);
      }, { timeout: 2000 })
      .toBe(true);
  });

  test('occupied sibling target input is NOT overwritten', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'rings', type: 'rings', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);
    // Pre-occupy cofefve.inR with a manual edge from a different source port.
    await page.evaluate(() => {
      const w = window as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.edges['manual-inR'] = {
          id: 'manual-inR',
          source: { nodeId: 'rings', portId: 'even' },
          target: { nodeId: 'coco', portId: 'inR' },
          sourceType: 'audio',
          targetType: 'audio',
        };
      });
    });

    // Now patch rings.odd → cofefve.inL. inR is occupied → no NEW auto-wire.
    await cascadePatch(page, { nodeId: 'rings', portId: 'odd' }, { nodeId: 'coco', portId: 'inL' });

    await expect
      .poll(async () => hasEdge(await readEdges(page), ['rings', 'odd'], ['coco', 'inL']), { timeout: 2000 })
      .toBe(true);
    const edges = await readEdges(page);
    // The pre-existing manual inR edge survives.
    expect(edges.some((e) => e.id === 'manual-inR')).toBe(true);
    // No duplicate canonical auto-wired edge id.
    expect(edges.some((e) => e.id === 'e-rings-even-coco-inR')).toBe(false);
  });

  test('MONO source into a stereo target L leaves the sibling UNPATCHED — and OUT R still speaks', async ({ page, rack }) => {
    // ⚠ THIS TEST USED TO CERTIFY A BUG. It asserted only the ABSENCE of the
    // sibling edge and justified that with "the engine normals R←L" — a claim
    // that was FALSE (engine.ts has no normalling code at all) and, for this
    // very module, produced max|outR| = 0.0000e+0. Every assertion it made was
    // true; the conclusion a reader drew from it was not.
    //
    // The wiring claim is unchanged and still correct — a mono source has no
    // stereoPairs sibling, so ONE edge is the right plan. What is added is the
    // AUDIBLE consequence, which is the half nobody was checking: leaving the
    // sibling unpatched is only acceptable because cofefve's DSP normals inR
    // from inL. If a factory ever defeats that normal again, this test now
    // fails instead of blessing the silence.
    // (The full per-module sweep lives in stereo-mono-normal.spec.ts.)
    await spawnPatch(page, [
      { id: 'vco', type: 'analogVco', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'coco', portId: 'inL' });

    await expect
      .poll(async () => hasEdge(await readEdges(page), ['vco', 'saw'], ['coco', 'inL']), { timeout: 2000 })
      .toBe(true);
    // Sibling inR stays unpatched — a mono source declares no stereoPairs
    // sibling, so there is no second leg to plan.
    const edges = await readEdges(page);
    expect(edges.some((e) => e.target.nodeId === 'coco' && e.target.portId === 'inR')).toBe(false);

    // …and the module's RIGHT output is nonetheless audible, because inR
    // normals from inL inside the worklet. Measured in-page, peak-held, so a
    // stalled main thread reports what it sampled rather than a false silence.
    const level = await page.evaluate(
      ({ ms }) =>
        new Promise<{ lPeak: number; rPeak: number; samples: number }>((resolve) => {
          const w = globalThis as unknown as {
            __engine: () => {
              getDomain(d: string): {
                getOutputNode(n: string, p: string): { node: AudioNode; output: number } | null;
              };
            };
          };
          const audio = w.__engine().getDomain('audio');
          const l = audio.getOutputNode('coco', 'outL');
          const r = audio.getOutputNode('coco', 'outR');
          if (!l || !r) throw new Error('cofefve out ports have no audio node');
          const ctx = l.node.context as AudioContext;
          const mk = (ref: { node: AudioNode; output: number }) => {
            const a = ctx.createAnalyser();
            a.fftSize = 2048;
            ref.node.connect(a, ref.output);
            return a;
          };
          const aL = mk(l), aR = mk(r);
          const bL = new Float32Array(aL.fftSize), bR = new Float32Array(aR.fftSize);
          let lPeak = 0, rPeak = 0, samples = 0;
          const peak = (b: Float32Array) => {
            let m = 0;
            for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i]!); if (v > m) m = v; }
            return m;
          };
          const t = setInterval(() => {
            aL.getFloatTimeDomainData(bL); aR.getFloatTimeDomainData(bR);
            lPeak = Math.max(lPeak, peak(bL)); rPeak = Math.max(rPeak, peak(bR)); samples++;
          }, 10);
          setTimeout(() => { clearInterval(t); resolve({ lPeak, rPeak, samples }); }, ms);
        }),
      { ms: 1200 },
    );

    const vitals = `L=${level.lPeak.toExponential(4)}, R=${level.rPeak.toExponential(4)}, samples=${level.samples}`;
    expect(level.lPeak, `cofefve outL must be making sound or the R claim is vacuous (${vitals})`)
      .toBeGreaterThan(0.005);
    expect(
      level.rPeak,
      `cofefve outR must be audible even though inR is UNPATCHED — that normal is the entire `
      + `justification for auto-wiring only one leg from a mono source. Silence here means the `
      + `single-edge plan above is silently throwing away half the signal (${vitals})`,
    ).toBeGreaterThan(0.005);
  });

  test('naming-agnostic target (charlottes-echos L/R): clouds out_l → L auto-wires out_r → R', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'ce', type: 'charlottesEchos', position: { x: 760, y: 100 } },
    ]);

    // clouds.out_l → charlottes-echos.L (input) ⇒ out_r → R auto-wired.
    await cascadePatch(page, { nodeId: 'clouds', portId: 'out_l' }, { nodeId: 'ce', portId: 'L' });

    await expect
      .poll(async () => {
        const edges = await readEdges(page);
        return hasEdge(edges, ['clouds', 'out_l'], ['ce', 'L']) && hasEdge(edges, ['clouds', 'out_r'], ['ce', 'R']);
      }, { timeout: 2000 })
      .toBe(true);
  });
});
