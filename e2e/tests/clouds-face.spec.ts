// e2e/tests/clouds-face.spec.ts
//
// Two things about the CLOUDS faceplate that NO other gate in the repo can see.
//
//   1. LABEL CLIPPING IS INVISIBLE TO faces-parity. It asserts with
//      `toHaveText`, which reads `textContent` — and a CSS ellipsis leaves no
//      trace there. This face parks a load-bearing fact in a band LABEL (band
//      hints and `face.hint` are ANNOTATION and paint nothing at rest, so a
//      label is one of the few always-painted surfaces a faceplate has), and
//      that label is 36 characters — inside the 46-character range already
//      shipping across the roster, but nothing checks the range, so it is
//      measured here in rendered CSS px instead of argued.
//
//   2. THE FREEZE LATCH IS A HOST-SIDE PROTOCOL, and its failure mode is
//      silent. `CloudsProcessor` ORs the a-rate `freeze` param with the FRZ
//      gate and TOGGLES on the rising edge, so the host must send exactly one
//      pulse per intended STATE CHANGE. The shipped `setParam` pulsed on EVERY
//      write whatever the value, which makes re-stating the current value —
//      a preset recall, an automation lane resending 0, a duplicate sync write
//      — INVERT the latch while the card keeps painting the old state. No unit
//      gate can see it (the latch lives in the worklet) and no def-reading gate
//      can either. The only honest observable is AUDIO.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

// ── 1 · the label + caption fit ─────────────────────────────────────────────

/** Every element in `row` whose TEXT is wider than its own box, in CSS px.
 *  `Range.getBoundingClientRect` measures the TEXT; `scrollWidth` is the wrong
 *  instrument, because it reports the CLAMPED box the moment an overflow rule
 *  engages — which is exactly the state this exists to detect. */
async function clippedIn(page: Page, testid: string): Promise<string[]> {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-testid="${id}"]`);
    const bad: string[] = [];
    for (const el of [...(row?.children ?? [])]) {
      const e = el as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(e);
      const textW = range.getBoundingClientRect().width;
      if (textW > e.clientWidth + 0.5) {
        bad.push(`"${e.textContent}" ${textW.toFixed(1)} CSS px in a ${e.clientWidth} px box`);
      }
    }
    return bad;
  }, testid);
}

test('clouds faceplate: the band LABEL carrying the two-second fact is not clipped', async ({
  page,
}) => {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, [{ id: 'cl', type: 'clouds', position: { x: 120, y: 120 } }]);

  const shell = page.locator('.svelte-flow__node[data-id="cl"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();
  await expect(faceplate.getByTestId('clouds-buffer')).toBeVisible();

  // The NARROWEST width the dock actually gives this faceplate: past the hero
  // panel's 380 px `minWidth` the pane scrolls rather than shrinking, so this
  // IS the worst case rather than an arbitrary small viewport.
  await page.setViewportSize({ width: 760, height: 900 });

  const label = faceplate.locator('.band-head, [class*="band"]').filter({ hasText: 'the ring' });
  await expect(
    faceplate,
    'the band label paints AT REST (no annotation switch) — this is the whole reason the ' +
      'two-second fact lives in a label rather than in face.hint',
  ).toContainText('the ring — 2 s, and it must FILL', { ignoreCase: true });
  void label;

  // The label element itself must not be truncated. Measured in CSS px against
  // its own box, on EVERY band header, so a future band inherits the check.
  const clippedLabels = await page.evaluate(() => {
    const bad: string[] = [];
    const root = document.querySelector('[data-testid="dock-full-view"]');
    for (const el of [...(root?.querySelectorAll('h3, h4, .band-label, .head-label') ?? [])]) {
      const e = el as HTMLElement;
      if (!e.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(e);
      if (range.getBoundingClientRect().width > e.clientWidth + 0.5) {
        bad.push(`"${e.textContent.trim()}" ${range.getBoundingClientRect().width.toFixed(1)} CSS px in ${e.clientWidth} px`);
      }
    }
    return bad;
  });
  expect(
    clippedLabels.join('; '),
    'a band label is wider than its box. With a CSS ellipsis that truncation leaves NO trace ' +
      'in textContent, so faces-parity and every other text-reading gate stay green while the ' +
      'faceplate stops saying the thing it exists to say.',
  ).toBe('');
});

test('clouds faceplate: no ring-axis caption is clipped, in EITHER label mode', async ({ page }) => {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await spawnPatch(page, [{ id: 'cl', type: 'clouds', position: { x: 120, y: 120 } }]);

  const shell = page.locator('.svelte-flow__node[data-id="cl"] [data-testid="module-shell"]');
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate.getByTestId('clouds-ring-axis')).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });

  const modeButton = faceplate.getByTestId('clouds-ring-scale');
  for (const mode of ['s', 'grains'] as const) {
    // ⚠ ASSERT THE MODE IS ACTUALLY ENTERED before measuring it — the
    // card-control-overflow lesson: a sweep that re-measures the default layout
    // twice is green about half of what it claims to cover.
    await expect(modeButton, `the axis is in ${mode} mode`).toHaveText(mode);
    expect(
      (await clippedIn(page, 'clouds-ring-axis')).join('; '),
      `${mode} mode: a ring caption is wider than its box`,
    ).toBe('');
    if (mode === 's') await modeButton.click();
  }
});

// ── 2 · the FREEZE latch, asserted in AUDIO ─────────────────────────────────

/** RMS of the scope's ch1 time-domain buffer. A LEVEL is the right instrument
 *  here (unlike everywhere else on this module): the question is "is the ring
 *  still playing back or has it recorded silence", which is exactly a level. */
async function scopeRms(page: Page, scopeId: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[id];
    if (!eng || !node) return 0;
    const snap = eng.read(node, 'snapshot') as { ch1?: Float32Array } | undefined;
    const buf = snap?.ch1;
    if (!buf || buf.length === 0) return 0;
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
    return Math.sqrt(s / buf.length);
  }, scopeId);
}

/**
 * Wait for the ring to TURN OVER, then report the largest RMS seen in a short
 * window. The max (rather than one sample) because "did the cloud keep sounding
 * at all" is a max question and a single analyser frame can land in a grain gap.
 *
 * ⚠ THE SETTLE IS THE INSTRUMENT, and leaving it out is the wrong-metric trap
 * in miniature. The first draft polled for the max over a window that STARTED
 * the moment the param moved — so the first ~2 s of every window were the ring
 * still holding its old contents, the max was always the pre-change level, and
 * the test could not distinguish frozen from thawed at all. MEASURED: with the
 * fix stubbed out (`if (false && …)` in the def) it passed. `settleMs` must be
 * at least `BUFFER_SECONDS` + one grain, which is what makes a thawed ring
 * demonstrably full of the (absent) input.
 */
async function settleThenPeak(
  page: Page,
  scopeId: string,
  settleMs: number,
  windowMs: number,
): Promise<number> {
  await page.waitForTimeout(settleMs);
  const deadline = Date.now() + windowMs;
  let best = 0;
  while (Date.now() < deadline) {
    best = Math.max(best, await scopeRms(page, scopeId));
    await page.waitForTimeout(60);
  }
  return best;
}

/** 2.0 s of ring + one 300 ms grain at the shipped SIZE, plus a little slack —
 *  the point past which a ring recording an ABSENT input is entirely silent. */
const TURNOVER_MS = 2600;

/**
 * Drive `PatchEngine.setParam` and NOTHING ELSE — the seam a preset recall, an
 * automation lane, a MIDI-learned CC, the group bar and the card's own FREEZE
 * button all land on, and therefore the faithful reproduction of the
 * duplicate-write bug.
 *
 * ⚠ IT DELIBERATELY DOES NOT WRITE THE Y.DOC, and that correction is the whole
 * reason this helper has a comment. The first draft wrote the durable param
 * too, "so the card and the engine agree" — which made the test BLIND: the sync
 * observer turns a Y.Doc param change into its OWN `setParam`, so every
 * intended write became two pulses on a param the worklet toggles per pulse,
 * and a duplicate Y.Doc write of an unchanged value became one. The net latch
 * state then came out RIGHT BY ACCIDENT under the old buggy code and the
 * negative control below passed. Measured, not reasoned: with the fix stubbed
 * out (`if (false && …)`) the test was green. One seam, one pulse, one
 * assertion.
 */
async function engineSetParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ id, p, v }) => {
      const w = globalThis as unknown as {
        __engine?: () => { setParam: (n: unknown, p: string, v: number) => void } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const node = w.__patch.nodes[id];
      w.__engine?.()?.setParam(node, p, v);
    },
    { id: nodeId, p: paramId, v: value },
  );
}

test('clouds: FREEZE holds the buffer, and re-writing the SAME value does not invert it', async ({
  page,
  rack,
}) => {
  // ⚠ THE WAITS BELOW ARE MILLISECONDS ON PURPOSE, and that is not the
  // frame-count rule being ignored — it is the rule's own premise. The quantity
  // under test is `BUFFER_SECONDS = 2.0`, which is AudioContext time: the ring
  // turns over in two seconds of AUDIO on every renderer, and a rAF count would
  // make it a different amount of audio per machine, i.e. exactly the error the
  // rule exists to prevent, inverted. Nothing here is rendered.
  test.setTimeout(75_000);
  void rack;
  // analogVco → clouds → scope. The source is removed by DELETING ITS EDGE
  // rather than muting a level, because that is unambiguous: with no input, an
  // UNFROZEN ring records digital silence and the cloud dies within the 2.0 s
  // it takes to turn over, while a FROZEN one loops forever.
  await spawnPatch(
    page,
    [
      { id: 'vco', type: 'analogVco', position: { x: 60, y: 80 } },
      {
        id: 'cl',
        type: 'clouds',
        position: { x: 320, y: 80 },
        // blend 1 so the reading is the GRAIN ENGINE and not the dry path —
        // at the def default of 0.5 half the output bypasses the ring
        // entirely, and this test would then be measuring the input.
        // density 0.9 keeps the cloud continuous, so a single analyser frame
        // cannot land in a grain gap and read as "it stopped".
        params: { blend: 1, density: 0.9 },
      },
      { id: 'scp', type: 'scope', position: { x: 620, y: 80 }, params: { timeMs: 100, ch1Range: 1 } },
      { id: 'out', type: 'audioOut', position: { x: 900, y: 80 }, params: { master: 0.0 } },
    ],
    [
      { id: 'src', from: { nodeId: 'vco', portId: 'saw' }, to: { nodeId: 'cl', portId: 'in_l' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e1', from: { nodeId: 'cl', portId: 'out_l' }, to: { nodeId: 'scp', portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
      { id: 'e2', from: { nodeId: 'scp', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );

  // THE RING MUST FILL FIRST — the module's headline fact, and here it is also
  // the test's setup step. Bit-zero for one grain length, ~12 dB down until
  // 2.0 s, full level one grain after that.
  const filled = await settleThenPeak(page, 'scp', TURNOVER_MS, 900);
  expect(filled, 'the cloud is audible once the 2.0 s ring has filled').toBeGreaterThan(0.02);

  // FREEZE ON — one write, one state change.
  await engineSetParam(page, 'cl', 'freeze', 1);
  // …and cut the source. From here, anything we hear is the held ring.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { edges: Record<string, unknown> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => { delete w.__patch.edges['src']; });
  });

  const held = await settleThenPeak(page, 'scp', TURNOVER_MS, 900);
  expect(
    held,
    `FREEZE must hold the buffer with no input, a full ring turnover later (peak RMS ` +
      `${held.toFixed(4)})`,
  ).toBeGreaterThan(0.02);

  // ⚠ THE REGRESSION. Write the value it ALREADY HOLDS. Under the shipped
  // `setParam` this pulsed the a-rate param again, the worklet toggled on the
  // rising edge, and the buffer silently un-froze while the card still painted
  // FREEZE as engaged — so the ring would record 2.0 s of silence and the cloud
  // would die.
  await engineSetParam(page, 'cl', 'freeze', 1);
  const stillHeld = await settleThenPeak(page, 'scp', TURNOVER_MS, 900);
  expect(
    stillHeld,
    `re-writing freeze=1 must be a NO-OP (peak RMS ${stillHeld.toFixed(4)}). If this is ~0 the ` +
      `duplicate write inverted the latch: the ring resumed recording the now-absent input and ` +
      `turned over to silence, which is exactly what a preset recall or an automation lane ` +
      `resending its current value does.`,
  ).toBeGreaterThan(0.02);

  // ⚠ POSITIVE CONTROL, and without it the two clauses above are worthless: a
  // clouds whose freeze NEVER released would pass both. A real state change
  // must un-freeze, the ring must record the absent input, and the cloud must
  // die — which also proves the instrument can see the difference at all.
  await engineSetParam(page, 'cl', 'freeze', 0);
  const thawed = await settleThenPeak(page, 'scp', TURNOVER_MS, 900);
  expect(
    thawed,
    `releasing FREEZE must let the ring record the (absent) input and go silent — peak RMS ` +
      `${thawed.toFixed(4)} vs ${stillHeld.toFixed(4)} while held. If this is still loud, the ` +
      `two clauses above prove nothing.`,
  ).toBeLessThan(held / 4);
});
