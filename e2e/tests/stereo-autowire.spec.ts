// e2e/tests/stereo-autowire.spec.ts
//
// THE LEG-GROUP COMMIT, end to end.
//
// Every case here drives the REAL redesigned commit gesture — open the source
// card's menu → drill OUTPUT → jack-click the output ROW (carry) → "patch to"
// → pick the target module → pick the target INPUT port → pickPortMenuTarget →
// writeAudioLegGroup. This is the ONLY full jack-click→carry→picker→commit
// flow gate in the suite, which is why the rewrite keeps that shape rather than
// poking the planner through a hook: the planner itself is exhaustively covered
// in packages/web/src/lib/graph/stereo-autowire.test.ts, and what THIS file is
// for is proving the wired call sites reach it.
//
// THE POLICY AS A HAND GESTURE MAKES IT (owner 2026-08-07 for the matrix,
// AMENDED 2026-08-12 for the two ambiguous rows):
//
//   stereo → stereo   L→L, R→R                                    — silent
//   mono   → stereo   the picker's pair / L / R rows answer it    — in place
//   stereo → mono     the WIDTH CHOOSER asks which channel        — ONE leg
//   mono   → mono     one leg                                     — silent
//
// ⚠ THE PLANNER'S MATRIX IS UNCHANGED and is NOT what this file pins. `mono →
// stereo` still double-patches and `stereo → mono` still writes dual-mono when
// `channelMode: 'both'` reaches `planAudioCommit` — the AI driver, the matrix
// mixer and the column autowire all still produce exactly that, and
// packages/web/src/lib/graph/stereo-autowire.test.ts is where those rows live.
// What changed is that no HAND GESTURE picks `both` for stereo → mono any
// more, because the owner replaced the guess with a question.
//
// ⚠ TWO TESTS HERE PINNED THE OPPOSITE BEHAVIOUR and are deliberately inverted:
//
//   * "MONO source into a stereo target L leaves the sibling UNPATCHED" — the
//     sibling is now PATCHED. That test's real payload (cofefve's OUT R must
//     speak) survives, but it no longer rests on the DSP's internal R←L normal;
//     the graph carries the right channel explicitly. The per-module normal
//     sweep still lives in stereo-mono-normal.spec.ts, which is where it
//     belongs — this file should not be the thing standing between a defeated
//     normal and a silent channel.
//   * "occupied sibling target input is NOT overwritten" — a stereo cable is
//     ONE cable and it REPLACES what it lands on (owner decision Q4,
//     leg-level occupancy). Replaced with the occupancy tests below, which pin
//     both halves: a FULL patch takes both legs, an only-X patch takes one.
//
// ⚠ SCOPE: this pins what is written to the GRAPH. Until PR-3b lands the
// engine's dual-mono wrapper, two legs into one mono input still sum in Web
// Audio — so there is deliberately no "the mono module keeps its stereo image"
// audio assertion here. That gate is PR-3b's to add.
//
// ⚠ `rings` keeps its declared-pair autowire even though odd/even sits in
// COLLAPSE_EXEMPT (two timbres → two jacks). Collapsing and wiring read
// different lists; the first test is the pin for that.

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

/** Every cable as `src.port -> dst.port`, sorted — the readable whole-graph
 *  assertion. A leg-group test wants to say what the graph IS, not only that
 *  one edge exists: "both legs written" and "both legs written PLUS a stale
 *  third" must not read the same. */
function summarize(edges: PatchEdge[]): string[] {
  return edges
    .map((e) => `${e.source.nodeId}.${e.source.portId} -> ${e.target.nodeId}.${e.target.portId}`)
    .sort();
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
 *  INPUT port — committing via pickPortMenuTarget → writeAudioLegGroup. */
async function cascadePatch(
  page: Page,
  src: { nodeId: string; portId: string },
  dst: { nodeId: string; portId: string },
  /** `choose` answers the WIDTH CHOOSER (owner 2026-08-12) — required exactly
   *  when the drop's two ends disagree about width and the picker did not
   *  already resolve it, i.e. STEREO source → MONO target. Passing it when no
   *  dialog opens FAILS rather than being ignored, so a caller cannot quietly
   *  keep it after the behaviour changes back. */
  opts: { choose?: 'left' | 'right' | 'both' } = {},
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
  // ⚠ `data-leg=""` PICKS THE WHOLE-PAIR ROW. A collapsed stereo target offers
  // three rows — the pair, its L and its R — since the per-leg drill-down
  // landed for the ES-9 return case (a MONO source naming one side of a
  // collapsed input). This file is about the POLICY MATRIX, i.e. what the
  // ordinary whole-jack patch writes, so it always takes the pair row; without
  // the filter the locator matches three and Playwright fails strict mode.
  const portRow = menu.locator(
    `[data-testid="patch-to-port"][data-port-id="${dst.portId}"][data-leg=""]`,
  );
  await expect(portRow).toBeVisible();
  await portRow.click();
  await expect(menu).toHaveCount(0);

  const chooser = page.getByTestId('stereo-drop-choice');
  if (opts.choose) {
    await expect(
      chooser,
      `expected the width chooser for ${src.portId} → ${dst.portId}`,
    ).toBeVisible();
    await chooser
      .locator(`[data-testid="stereo-drop-choice-option"][data-mode="${opts.choose}"]`)
      .click();
    await expect(chooser).toHaveCount(0);
  } else {
    await expect(
      chooser,
      `an unexpected width chooser opened for ${src.portId} → ${dst.portId}`,
    ).toHaveCount(0);
  }
}

/** Wait for the graph to settle on an exact cable set. Polls the WHOLE summary
 *  so an extra edge fails as loudly as a missing one. */
async function expectGraph(page: Page, expected: string[]) {
  await expect
    .poll(async () => summarize(await readEdges(page)), { timeout: 3000 })
    .toEqual([...expected].sort());
}

// ───────────────────────────── the four rows ─────────────────────────────

test.describe('leg-group commit — the policy matrix', () => {
  test('stereo → stereo: L→L and R→R from ONE action (rings odd/even → cofefve inL/inR)', async ({
    page,
    rack,
  }) => {
    // Also the RINGS pin: odd/even is COLLAPSE_EXEMPT (two timbre taps, two
    // jacks) and STILL autowires, because the commit planner reads the WIRING
    // pair list and not the collapse one. Reading the wrong list would leave
    // exactly one edge here and look like a perfectly ordinary mono patch.
    await spawnPatch(page, [
      { id: 'rings', type: 'rings', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'rings', portId: 'odd' }, { nodeId: 'coco', portId: 'inL' });

    await expectGraph(page, ['rings.odd -> coco.inL', 'rings.even -> coco.inR']);
  });

  test('mono → stereo: the single out is DOUBLE-PATCHED into both target legs', async ({
    page,
    rack,
  }) => {
    // ⚠ INVERTED from the pre-2026-08-07 behaviour, which left the sibling
    // unpatched and relied on the target module's own DSP to normal R←L. The
    // graph now carries the right channel explicitly, so a module whose factory
    // defeats its internal normal can no longer ship a silent R from this path.
    await spawnPatch(page, [
      { id: 'vco', type: 'analogVco', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'coco', portId: 'inL' });

    await expectGraph(page, ['vco.saw -> coco.inL', 'vco.saw -> coco.inR']);

    // …and BOTH outputs speak. Measured in-page, peak-held on a setInterval, so
    // a stalled main thread reports what it sampled rather than a false
    // silence (never a Playwright-side poll loop over the subject's own thread).
    const level = await readStereoPeaks(page, 'coco', 'outL', 'outR');
    const vitals = `L=${level.lPeak.toExponential(4)}, R=${level.rPeak.toExponential(4)}, samples=${level.samples}`;
    expect(level.lPeak, `cofefve outL must be making sound or the R claim is vacuous (${vitals})`)
      .toBeGreaterThan(0.005);
    expect(
      level.rPeak,
      `cofefve outR must be audible — the R leg is now PATCHED, so silence here is a `
        + `dead second leg, not a defeated DSP normal (${vitals})`,
    ).toBeGreaterThan(0.005);
  });

  test('stereo → MONO: the gesture ASKS which channel and writes ONE leg', async ({
    page,
    rack,
  }) => {
    // ⚠ THIS TEST USED TO PIN DUAL-MONO — "BOTH legs land on the mono input".
    // The owner replaced that gesture on 2026-08-12: a stereo source dropped on
    // a mono jack now asks which channel, and there is no BOTH row. The
    // dual-mono SHAPE is not gone — `planAudioCommit` still writes it for
    // `channelMode: 'both'`, which the programmatic writers use and
    // stereo-autowire.test.ts pins — but no hand gesture produces it any more,
    // so pinning it HERE (the wired-call-sites file) would pin a path that no
    // longer exists.
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'filt', type: 'filter', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(
      page,
      { nodeId: 'clouds', portId: 'out_l' },
      { nodeId: 'filt', portId: 'audio' },
      { choose: 'right' },
    );

    await expectGraph(page, ['clouds.out_r -> filt.audio']);

    // The negative half: exactly ONE cable terminates on that mono input. A
    // chooser that opened and then wrote the old pair anyway would satisfy
    // "the R leg exists".
    const onInput = (await readEdges(page)).filter(
      (e) => e.target.nodeId === 'filt' && e.target.portId === 'audio',
    );
    expect(
      onInput.map((e) => e.source.portId).sort(),
      'the user chose a CHANNEL — the other leg must not be written behind it',
    ).toEqual(['out_r']);
  });

  test('mono → mono: exactly ONE leg', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'vco', type: 'analogVco', position: { x: 80, y: 100 } },
      { id: 'filt', type: 'filter', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'vco', portId: 'saw' }, { nodeId: 'filt', portId: 'audio' });

    await expectGraph(page, ['vco.saw -> filt.audio']);
  });

  test('naming-agnostic target (charlottes-echos L/R): clouds out_l → L takes out_r → R', async ({
    page,
    rack,
  }) => {
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'ce', type: 'charlottesEchos', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'clouds', portId: 'out_l' }, { nodeId: 'ce', portId: 'L' });

    await expectGraph(page, ['clouds.out_l -> ce.L', 'clouds.out_r -> ce.R']);
  });
});

// ───────────────────────── leg-level occupancy (Q4) ─────────────────────────

test.describe('leg-level occupancy', () => {
  test('a FULL stereo patch REPLACES both legs of the target', async ({ page, rack }) => {
    // ⚠ INVERTED from "occupied sibling target input is NOT overwritten". Under
    // the leg-group model a stereo cable is ONE cable: patching it onto an
    // occupied stereo input replaces what was there, exactly as a mono cable
    // always has. Half-patching around an existing leg would leave the target
    // fed by two different sources with no way to see it.
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'rings', type: 'rings', position: { x: 80, y: 420 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    await cascadePatch(page, { nodeId: 'rings', portId: 'odd' }, { nodeId: 'coco', portId: 'inL' });
    await expectGraph(page, ['rings.odd -> coco.inL', 'rings.even -> coco.inR']);

    await cascadePatch(
      page,
      { nodeId: 'clouds', portId: 'out_l' },
      { nodeId: 'coco', portId: 'inL' },
    );
    await expectGraph(page, ['clouds.out_l -> coco.inL', 'clouds.out_r -> coco.inR']);
  });

  test('an only-L and an only-R cable from DIFFERENT sources coexist on one input', async ({
    page,
    rack,
  }) => {
    // The other half of Q4. There is no only-L/R UI until PR-4, so the single
    // legs are seeded directly — which is also the LEGACY shape: a rack saved
    // before this change holds exactly these, and they must not annihilate each
    // other on load or on the next patch.
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'rings', type: 'rings', position: { x: 80, y: 420 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);

    await seedEdges(page, [
      { id: 'legacy-L', from: ['clouds', 'out_l'], to: ['coco', 'inL'] },
      { id: 'legacy-R', from: ['rings', 'even'], to: ['coco', 'inR'] },
    ]);
    await expectGraph(page, ['clouds.out_l -> coco.inL', 'rings.even -> coco.inR']);

    // Both survive a reload-free settle — nothing reconciles them away.
    await page.waitForTimeout(300);
    await expectGraph(page, ['clouds.out_l -> coco.inL', 'rings.even -> coco.inR']);
  });
});

// ───────────────────────── leg-group removal ─────────────────────────

test.describe('leg-group removal', () => {
  test('unpatching ONE leg removes the WHOLE cable (no orphaned half)', async ({ page, rack }) => {
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);
    await cascadePatch(
      page,
      { nodeId: 'clouds', portId: 'out_l' },
      { nodeId: 'coco', portId: 'inL' },
    );
    await expectGraph(page, ['clouds.out_l -> coco.inL', 'clouds.out_r -> coco.inR']);

    // Right-click the L input row on the target's drill-down panel.
    await openMenu(page, 'coco');
    await chrome(page, 'coco')
      .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
      .click();
    const inL = chrome(page, 'coco').locator(
      '[data-testid="patch-panel-port-row"][data-port-id="inL"]',
    );
    await expect(inL.locator('[data-testid="port-row-jack"]')).toHaveAttribute(
      'data-patched',
      'true',
    );
    await inL.click({ button: 'right' });

    const menu = page.getByTestId('unpatch-menu');
    await expect(menu).toBeVisible();
    // ONE row for one cable — not one row per leg — and NO "(L only)" suffix,
    // because nothing about this cable is missing.
    const items = menu.getByTestId('unpatch-item');
    await expect(items).toHaveCount(1);
    // Named for the JACK (`OUT`), not for a leg. This pinned `OUT_L` — the
    // label bug the owner reported on #1409: a COMPLETE stereo group described
    // by one of its legs while the jack a click away said `OUT`.
    await expect(items).toHaveText(/Unpatch — clouds OUT$/i);
    await expect(items).toHaveAttribute('data-solo-channel', '');

    await items.click();
    // BOTH legs gone. Under the pre-PR-3 removal this left
    // `clouds.out_r -> coco.inR` behind, invisible once PR-4 renders the pair
    // as one cable, with no affordance left to remove it.
    await expectGraph(page, []);
  });

  test('a LEGACY single leg is labelled "(L only)" and removes just itself', async ({
    page,
    rack,
  }) => {
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'coco', type: 'cofefve', position: { x: 760, y: 100 } },
    ]);
    await seedEdges(page, [{ id: 'legacy-L', from: ['clouds', 'out_l'], to: ['coco', 'inL'] }]);

    await openMenu(page, 'coco');
    await chrome(page, 'coco')
      .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
      .click();
    await chrome(page, 'coco')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="inL"]')
      .click({ button: 'right' });

    const items = page.getByTestId('unpatch-menu').getByTestId('unpatch-item');
    await expect(items).toHaveCount(1);
    await expect(items).toHaveText(/\(L only\)$/);
    await expect(items).toHaveAttribute('data-solo-channel', 'left');

    await items.click();
    await expectGraph(page, []);
  });

  test('a stereo→MONO group lists ONCE and removes both legs off one input', async ({
    page,
    rack,
  }) => {
    // Both legs terminate on the SAME port here, so this is the case where a
    // per-edge menu would show two identical rows and an "Unpatch all (2)" for
    // what the user sees as one cable.
    //
    // ⚠ SEEDED, NOT GESTURED, since 2026-08-12. The hand gesture that used to
    // build this shape now asks for a channel and writes one leg, but the shape
    // itself is still live and still has to delete as ONE cable: the matrix
    // mixer and the AI driver both call `planAudioCommit` with `both`, and a
    // rack saved before the chooser carries it. Losing the coverage because the
    // gesture moved would leave leg-group deletion untested on the exact
    // topology it was written for — two legs, one input port.
    await spawnPatch(page, [
      { id: 'clouds', type: 'clouds', position: { x: 80, y: 100 } },
      { id: 'filt', type: 'filter', position: { x: 760, y: 100 } },
    ]);
    await seedEdges(page, [
      { id: 'e-clouds-out_l-filt-audio', from: ['clouds', 'out_l'], to: ['filt', 'audio'] },
      { id: 'e-clouds-out_r-filt-audio', from: ['clouds', 'out_r'], to: ['filt', 'audio'] },
    ]);
    await expectGraph(page, ['clouds.out_l -> filt.audio', 'clouds.out_r -> filt.audio']);

    await openMenu(page, 'filt');
    await chrome(page, 'filt')
      .locator('[data-testid="patch-panel-nav"][data-nav="inputs"]')
      .click();
    await chrome(page, 'filt')
      .locator('[data-testid="patch-panel-port-row"][data-port-id="audio"]')
      .click({ button: 'right' });

    const menu = page.getByTestId('unpatch-menu');
    await expect(menu.getByTestId('unpatch-item')).toHaveCount(1);
    await expect(menu.getByTestId('unpatch-all')).toHaveCount(0);
    await menu.getByTestId('unpatch-item').click();
    await expectGraph(page, []);
  });
});

// ───────────────────────────── helpers ─────────────────────────────

/** Seed raw edges through the app's own Y.Doc — used for LEGACY single-leg
 *  shapes (a rack saved before leg groups existed) that no UI writes yet. */
async function seedEdges(
  page: Page,
  specs: { id: string; from: [string, string]; to: [string, string] }[],
): Promise<void> {
  await page.evaluate((rows) => {
    const w = window as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      for (const r of rows) {
        w.__patch.edges[r.id] = {
          id: r.id,
          source: { nodeId: r.from[0], portId: r.from[1] },
          target: { nodeId: r.to[0], portId: r.to[1] },
          sourceType: 'audio',
          targetType: 'audio',
        };
      }
    });
  }, specs);
}

/** Peak-held L/R levels off two OUTPUT ports of one node, accumulated INSIDE
 *  the page (never a Playwright-side poll loop, which would starve the very
 *  main thread it is measuring and report a stall as a silence). */
async function readStereoPeaks(
  page: Page,
  nodeId: string,
  leftPort: string,
  rightPort: string,
): Promise<{ lPeak: number; rPeak: number; samples: number }> {
  return await page.evaluate(
    ({ ms, nodeId, leftPort, rightPort }) =>
      new Promise<{ lPeak: number; rPeak: number; samples: number }>((resolve) => {
        const w = globalThis as unknown as {
          __engine: () => {
            getDomain(d: string): {
              getOutputNode(n: string, p: string): { node: AudioNode; output: number } | null;
            };
          };
        };
        const audio = w.__engine().getDomain('audio');
        const l = audio.getOutputNode(nodeId, leftPort);
        const r = audio.getOutputNode(nodeId, rightPort);
        if (!l || !r) throw new Error(`${nodeId} ${leftPort}/${rightPort} have no audio node`);
        const ctx = l.node.context as AudioContext;
        const mk = (ref: { node: AudioNode; output: number }) => {
          const a = ctx.createAnalyser();
          a.fftSize = 2048;
          ref.node.connect(a, ref.output);
          return a;
        };
        const aL = mk(l),
          aR = mk(r);
        const bL = new Float32Array(aL.fftSize),
          bR = new Float32Array(aR.fftSize);
        let lPeak = 0,
          rPeak = 0,
          samples = 0;
        const peak = (b: Float32Array) => {
          let m = 0;
          for (let i = 0; i < b.length; i++) {
            const v = Math.abs(b[i]!);
            if (v > m) m = v;
          }
          return m;
        };
        const t = setInterval(() => {
          aL.getFloatTimeDomainData(bL);
          aR.getFloatTimeDomainData(bR);
          lPeak = Math.max(lPeak, peak(bL));
          rPeak = Math.max(rPeak, peak(bR));
          samples++;
        }, 10);
        setTimeout(() => {
          clearInterval(t);
          resolve({ lPeak, rPeak, samples });
        }, ms);
      }),
    { ms: 1200, nodeId, leftPort, rightPort },
  );
}
