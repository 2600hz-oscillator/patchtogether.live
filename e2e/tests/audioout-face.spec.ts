// e2e/tests/audioout-face.spec.ts
//
// THE PROMOTED AUDIO OUT FACEPLATE — the two affordances that MOVED, and the
// picture that is new.
//
// ── WHY THIS FILE, GIVEN THE UNIT LANE ALREADY EXISTS ─────────────────────
//
// `audioout-face-model.test.ts` proves the meter's arithmetic and the picker's
// two dead states against fakes. What it structurally cannot see is whether the
// BODY is mounted on the surfaces a player reaches, and whether the meter is
// wired to the REAL terminal rather than to a plausible-looking read. Those are
// the two things this file exists for, and the second one is asserted through
// the real source chain: a real oscillator, a real cable, the real
// `ctx.destination` tail.
//
// ── AND WHY THE LEGACY SPECS CANNOT COVER IT ──────────────────────────────
//
// `audio-in.spec.ts` carries the only automated coverage of the setSinkId
// picker, and BOTH of its relevant tests drive `/rack?shell=legacy`. They pass
// unchanged across this promotion — and they would pass unchanged if the face
// had shipped with no picker at all, because under that flag `shellFaces` is
// false and the card is what renders. That is a suite going green-and-blind on
// the surface a user now actually gets. This file is the same claims on the
// DEFAULT shell.
//
// ── WHAT THIS SPEC STRUCTURALLY CANNOT SEE ────────────────────────────────
//
//   * PIXELS — `face-audioOut-compact.png` / `face-audioOut-dock.png` in the
//     shell-faces sweep.
//   * A REAL `setSinkId` CALL. A CI runner has no audio hardware and no
//     microphone permission, so the picker's OPERABLE state is not reachable
//     there. The legs below therefore assert the picker is PRESENT and that its
//     state is NAMED, both of which are capability-independent; the apply path
//     is the unit lane's and the handle's.
//   * The `?shell=legacy` arm — `audio-in.spec.ts` keeps it.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, canvasNode } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const OUT = 'faced-out';
const SRC = 'faced-src';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}
/** Minus the audio/permission noise a runner with no microphone produces on
 *  this surface by design — the same filter the audio-I/O scenes apply. */
function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !/getUserMedia|audio|mediaDevices|permission/i.test(e));
}

/**
 * The DEFAULT shell — no `shell` query, so faceplates render. That is the whole
 * file.
 *
 * ⚠ `seed` IS A REAL CHOICE, not boilerplate, and the two callers want opposite
 * things:
 *
 *   * `seed: 'none'` — the empty-rack fixture. Needed by every leg that SPAWNS
 *     its own audioOut, because a seeded default-shell rack frames its viewport
 *     on the video zone and xyflow does not keep off-screen nodes in the DOM:
 *     the spawn mounts nothing findable. (Measured — the mount budget exhausted
 *     on both ids with the canvas painted and empty.)
 *   * SEEDED — required by the pinned leg, because `?seed=none` suppresses the
 *     pinned-module ensure, so there would be no `pinned-audioOut` to look at.
 *     The one leg that is ABOUT the pinned instance therefore cannot use the
 *     empty fixture, and the ones that are about the face itself must.
 */
async function gotoDefaultShell(page: Page, seed: 'none' | 'seeded'): Promise<void> {
  await page.goto(seed === 'none' ? '/rack?seed=none' : '/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
}

/** Spawn `SRC → OUT.<port>` and open OUT's dock full view. Returns the pane. */
async function openFacedOut(page: Page, port: 'L' | 'R' | 'both') {
  const edges = [
    ...(port === 'L' || port === 'both'
      ? [{ id: 'e-l', from: { nodeId: SRC, portId: 'saw' }, to: { nodeId: OUT, portId: 'L' } }]
      : []),
    ...(port === 'R' || port === 'both'
      ? [{ id: 'e-r', from: { nodeId: SRC, portId: 'saw' }, to: { nodeId: OUT, portId: 'R' } }]
      : []),
  ];
  await spawnPatch(
    page,
    [
      { id: SRC, type: 'analogVco', position: { x: 120, y: 120 } },
      { id: OUT, type: 'audioOut', position: { x: 520, y: 120 } },
    ],
    edges,
  );
  await expect(canvasNode(page, OUT)).toBeVisible();
  // ⚠ PROVE THE CABLE EXISTS BEFORE MEASURING THE METER. `spawnPatch` accepts a
  // malformed edge silently — an early draft of this file wrote
  // `{source,target}` instead of `{from,to}` and the meter dutifully read
  // `silent`, which is the CORRECT answer to an unpatched terminal and looks
  // exactly like a broken body. Without this leg the failure blames the
  // instrument instead of the fixture.
  for (const e of edges) {
    await expect
      .poll(
        () =>
          page.evaluate(
            ([s, sp, d, dp]) => {
              const w = globalThis as unknown as {
                __patch: {
                  edges: Record<
                    string,
                    | {
                        source: { nodeId: string; portId: string };
                        target: { nodeId: string; portId: string };
                      }
                    | undefined
                  >;
                };
              };
              return Object.values(w.__patch.edges).some(
                (x) =>
                  !!x &&
                  x.source.nodeId === s &&
                  x.source.portId === sp &&
                  x.target.nodeId === d &&
                  x.target.portId === dp,
              );
            },
            [e.from.nodeId, e.from.portId, e.to.nodeId, e.to.portId] as const,
          ),
        {
          message: `the ${e.from.portId} → ${e.to.portId} cable must exist before the meter is read`,
        },
      )
      .toBe(true);
  }
  await page.evaluate((id) => {
    (globalThis as unknown as { __openDockFullView: (n: string) => void }).__openDockFullView(id);
  }, OUT);
  const pane = page.locator(`[data-pane-node="${OUT}"]`);
  await expect(pane.locator('[data-testid="module-shell"]')).toBeVisible({ timeout: BOOT_MS });
  return pane;
}

/** The meter's spoken level. The ONLY surface the measurement appears on — the
 *  face paints no numbers, by ruling. */
function meterText(root: ReturnType<Page['locator']>) {
  return root.getByTestId('audioout-face-meter').getAttribute('aria-valuetext');
}

test.describe('audioOut faceplate — the bespoke body', () => {
  test('the PINNED audio out renders the face IN THE 🎧 PANEL, carrying both moved affordances', async ({
    page,
  }) => {
    // THE INSTANCE THAT MATTERS. The pinned audio out is canvas-hidden, so this
    // panel is its ONLY surface; if the promotion had not reached it, every
    // other leg in this file could still be green while the module every user
    // has in every session kept its legacy card.
    const errors = collectErrors(page);
    await gotoDefaultShell(page, 'seeded');
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
        };
        return w.__patch?.nodes['pinned-audioOut']?.data?.pinned === true;
      },
      undefined,
      { timeout: BOOT_MS },
    );
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    const panel = page.getByTestId('workflow-io-panel');
    await expect(panel).toHaveAttribute('data-open', 'true');

    const host = panel.getByTestId('workflow-io-audioout-host');
    const shell = host.locator('[data-testid="module-shell"]');
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-shell-view', 'drawer');

    // ── THE TWO AFFORDANCES THAT MOVED OFF THE CARD ────────────────────────
    // Both live in the extension body, which is the whole reason this module's
    // migration disposition was `bespoke-surface`. If the body failed to
    // resolve, the shell degrades SILENTLY to a faceplate with one fader on it
    // — which still satisfies every generic gate.
    await expect(host.getByTestId('audioout-output-body')).toBeVisible();
    await expect(
      host.getByTestId('audioout-face-device-select'),
      'the setSinkId picker moved onto the face; the card is not rendered here any more',
    ).toBeVisible();
    await expect(host.getByTestId('audioout-face-meter')).toBeVisible();
    // …and the LEGACY card is gone from this host, which is the owner-visible
    // half of the promotion.
    await expect(host.getByTestId('audioout-device-select')).toHaveCount(0);

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the METER tracks the REAL terminal, and reads the PER-CHANNEL taps', async ({ page }) => {
    // ⚠ THIS IS THE LEG THE UNIT LANE CANNOT WRITE. The model test proves the
    // arithmetic against a fake `read`; only this proves the body is wired to
    // the analyser hanging off the node that feeds `ctx.destination`.
    //
    // ⚠ AND IT IS DRIVEN ONE-SIDED ON PURPOSE. A both-channels stimulus would
    // be satisfied by a meter built on the MONO downmix — which is the exact
    // regression the per-channel taps exist to prevent, and which would paint a
    // plausible moving bar. Only an asymmetric signal separates them.
    const errors = collectErrors(page);
    await gotoDefaultShell(page, 'none');
    const pane = await openFacedOut(page, 'L');

    await expect
      .poll(() => meterText(pane), {
        message:
          'the terminal meter must leave the silent state once a real oscillator is patched into ' +
          'L — if it never does, the body is not reading the engine',
        timeout: BOOT_MS,
      })
      .not.toBe('silent');

    const text = (await meterText(pane))!;
    // LEFT is audible, RIGHT is at the floor. A mono-key meter reports ONE
    // number and could not produce this pair at all.
    expect(text, `meter aria-valuetext: ${text}`).toMatch(/^left -?\d+(\.\d)? dBFS/);
    expect(
      text,
      'nothing is patched into R, so the right bar must read the floor — a mono downmix would ' +
        'have shown the same (halved) level on both',
    ).toContain('right silent');

    // NOTHING NUMERIC IS PAINTED. The measurement is in `aria-valuetext` and
    // nowhere else; a dB readout beside the picture is the hero readout strip
    // the fleet deleted.
    await expect(
      pane.locator('[data-testid^="readout-"]'),
      'a resting readout appeared on a face whose params declare no NAME vocabulary',
    ).toHaveCount(0);
    const painted = await pane
      .getByTestId('audioout-output-body')
      .evaluate((el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(
      painted,
      `the body paints no dB text of its own (found: "${painted}") — the device names in the ` +
        'picker are the only text here, and they are option NAMES',
    ).not.toMatch(/dBFS|-?\d+(\.\d+)?\s*dB\b/);

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the meter separates an ANTI-PHASE pair from silence — where the mono tap cannot', async ({
    page,
  }) => {
    // The sharper half of the same control, and the one the def spends twenty
    // lines on: on an anti-phase stereo pair the MONO tap reads ~0, so
    // "perfectly silent" and "perfectly cancelling" are the same number there.
    // Patching ONE oscillator into BOTH sides is not anti-phase, so this drives
    // the closest thing the graph can build without a phase inverter: both bars
    // must move, and both must be named.
    const errors = collectErrors(page);
    await gotoDefaultShell(page, 'none');
    const pane = await openFacedOut(page, 'both');

    await expect
      .poll(() => meterText(pane), { timeout: BOOT_MS })
      .not.toBe('silent');
    const text = (await meterText(pane))!;
    expect(text, `meter aria-valuetext: ${text}`).toMatch(/^left -?\d+(\.\d)? dBFS/);
    expect(
      text,
      'both channels are fed, so NEITHER may read the floor — this is the leg that moves if the ' +
        'body ever regresses to one shared reading',
    ).not.toContain('silent');

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('MASTER is a FADER, not a dial, and dragging it reaches the graph', async ({ page }) => {
    // `'fader'` and `'hue'` are the two primitives the shell cannot infer, so an
    // undeclared `paramCells` silently renders a KNOB — the #2144 class, which
    // every code gate missed and only a picture caught. Asserted on the
    // rendered CELL, not on the declaration.
    const errors = collectErrors(page);
    await gotoDefaultShell(page, 'none');
    const pane = await openFacedOut(page, 'L');

    await expect(
      pane.locator('[data-cell-control="fader"][data-cell-key="master"]'),
      'master renders as the neon throw the card has always drawn, not a dial',
    ).toHaveCount(1);

    const cell = pane.locator('[data-testid="control-master"]');
    await expect(cell).toBeVisible();
    await cell.scrollIntoViewIfNeeded();
    const before = await page.evaluate((id) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch.nodes[id]?.params?.master ?? null;
    }, OUT);
    const box = (await cell.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 40, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
            };
            return w.__patch.nodes[id]?.params?.master ?? null;
          }, OUT),
        { message: 'dragging the face fader must commit into __patch' },
      )
      .not.toBe(before);

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the PICKER names its state — including WHICH of the two causes disabled it', async ({
    page,
  }) => {
    // ⚠ CAPABILITY-INDEPENDENT BY CONSTRUCTION, which is why this is a BRANCH
    // and not a mid-test skip. A runner with no audio hardware lands in
    // `no-devices`; a browser without `AudioContext.setSinkId` lands in
    // `unsupported`; a real machine lands operable. All three are legitimate
    // and all three are asserted — the claim under test is that the state is
    // NAMED, which is precisely what the card could not do. A mid-test skip
    // would mark the whole case skipped on CI and hide the half that did run.
    const errors = collectErrors(page);
    await gotoDefaultShell(page, 'none');
    const pane = await openFacedOut(page, 'L');

    const picker = pane.getByTestId('audioout-face-device-select');
    await expect(picker).toBeVisible();
    const block = await picker.getAttribute('data-block');
    const text = await picker.getAttribute('aria-valuetext');
    expect(
      ['none', 'unsupported', 'no-devices'],
      `the picker must report one of the three named states (got ${block})`,
    ).toContain(block);

    if (block === 'unsupported') {
      await expect(picker).toBeDisabled();
      expect(text).toBe('output device selection is unavailable in this browser');
    } else if (block === 'no-devices') {
      await expect(picker).toBeDisabled();
      // THE DEFECT THIS LEG IS ABOUT: on the card this state produced a greyed
      // `(no outputs)` and NO explanation at all, because the notice rendered
      // only for the OTHER cause.
      expect(
        text,
        'a supporting browser that enumerated nothing must say so — not merely go grey',
      ).toBe('no output devices found');
    } else {
      await expect(picker).toBeEnabled();
      expect(text, 'an operable picker names the device, not a state word').not.toBe(
        'no output devices found',
      );
      expect(text).not.toBe('output device selection is unavailable in this browser');
      expect((text ?? '').length, 'an operable picker must name something').toBeGreaterThan(0);
    }

    // NO RESTING SENTENCE EITHER WAY. The card painted the support notice
    // forever on a non-Chromium browser; the face says it in `aria-valuetext`
    // and paints nothing.
    const painted = await pane
      .getByTestId('audioout-output-body')
      .evaluate((el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(
      painted,
      `the face must not paint the support/no-devices sentence (found: "${painted}")`,
    ).not.toMatch(/unavailable in this browser|no output devices found/);

    expect(realErrors(errors), `pageerrors: ${errors.join(' | ')}`).toEqual([]);
  });
});
