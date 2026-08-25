// e2e/tests/launchpad-monitor-survives-card-collapse.spec.ts
//
// OUT TO LAUNCH must keep driving its Launchpad when the surface that bound it
// goes away (#1728, from the #1583 audit's `pumps-leases` lens).
//
// ⚠ THE FILENAME STILL SAYS "CARD" AND THE SUBJECT IS NOW THE FACEPLATE BODY.
// The module was promoted to a PF-20 face (2026-08-25), so `migrated()` is true
// and neither surface renders `OutToLaunchCard` any more: the binder lives in
// the extension's `fullViewBody`, which unmounts on dock collapse and on LRU
// eviction in EXACTLY the same way the card did. The defect class is unchanged
// and so is every assertion below it — only the element that comes and goes is
// different. The name is kept because #1728 is what people search for.
//
// ⚠ AND ONE ASSERTION HAD TO MOVE RATHER THAN BE RE-POINTED CASUALLY. The
// ARRANGE leg proving the collapse DID something used to count the card, which
// after promotion is 0 in every state — green, blind, and ready to certify the
// next regression. See the note at the ACT step.
//
// `OutToLaunchCard` ran:
//
//     onDestroy(() => {
//       if (rafId !== null) cancelAnimationFrame(rafId);
//       if (isMonitorBound(id)) unbindMonitor(id);
//     });
//
// and `unbindMonitor` is not a passive detach — it writes every addressable LED
// to (0,0,0), sends `encodeExitProgrammerMode()`, and deletes the claim. A card
// unmounts on COLLAPSE, on dock LRU eviction when a THIRD unrelated module is
// expanded, on ESC and on navigation. None of those mean the performer is done
// with the monitor, and `bindMonitor` persists nothing to `node.data`, so
// nothing re-establishes it on remount.
//
// ⚠ WHY THIS ROW REACHES FURTHER THAN ITS SIBLINGS. Every other member of the
// #1583 family lost something inside the tab. This one drives HARDWARE: the
// physical surface goes dark, and the device is handed back to Live mode — at
// which point LAUNCHPAD CONTROL is free to claim it, so re-expanding may not
// even be able to take it back. That is a worse mid-performance failure than a
// silent software one.
//
// ── THE INSTRUMENT, AND WHAT IT CANNOT SEE ────────────────────────────────
// There is no real Launchpad on CI and there never will be, so this drives
// `__launchpadMonitorTestInstall()` — an in-memory Mini Mk3 that no
// clip-launcher unit claims (the existing L/R sims bind their ports to units,
// which `isOutputClaimed` then refuses a monitor on, by design).
//
// It MODELS THE DEVICE, not the wire: every byte run it receives is decoded
// (`decodeSurfaceSysex`, round-tripped against the encoders in
// launchpad-sysex.test.ts) into the LED state and mode a real surface would
// hold. So `device.litIndices` and `device.programmer` are the SURFACE's own
// facts. A probe reading the host's `lastRgb` diff map would instead report
// what the sender BELIEVED it sent, and would be blind to a frame that never
// left — which is the half of this defect that matters most.
//
// WHAT IT STILL CANNOT SEE, stated so a green run is not over-read:
//   * that a REAL Mini Mk3 honours these frames the way the sim assumes
//     (the byte layer is golden-vector tested; the hardware is not on CI);
//   * USB/CoreMIDI-level effects — a port vanishing, a replug, WinMM's
//     duplicate port naming (#1101; `enumerateLaunchpadPorts` owns that and
//     is untouched here);
//   * LED persistence timing on the physical panel.
// It CAN see, exactly: the claim, the mode, the LED state the device would
// hold, and whether frames keep arriving.
//
// The probe deliberately reads the CLAIM from the device layer's `monitors`
// map (the thing `unbindMonitor` deletes) rather than from the node registry —
// the registry's opinion of a claim it does not itself hold would be no
// evidence at all.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const SRC = 'src';
const OTL = 'otl';
/** The faceplate binder body — the surface that unmounts on collapse now that
 *  the module is faced, i.e. THIS SPEC'S SUBJECT. */
const BODY = `out-to-launch-binder-body-${OTL}`;
/** The MONITOR lamp: the card's `MONITOR ACTIVE` banner, as the resting-text
 *  ruling requires it — a boolean picture with the sentence in `aria-label`. */
const LAMP = `out-to-launch-led-monitor-${OTL}`;

interface DeviceState {
  /** Is the surface in PROGRAMMER mode (we own its LEDs)? */
  programmer: boolean;
  /** Which indices the DEVICE currently shows as not-black. Rows, not a count. */
  litIndices: number[];
  /** Lighting frames the device actually received — the pump's causal quantity
   *  (units: frames delivered to the device, not host intentions). */
  framesReceived: number;
  ledAt11: [number, number, number] | null;
  ledAt99: [number, number, number] | null;
}

interface MonitorProbe {
  bound: boolean;
  outputId: string | null;
  /** The registry's own pump bookkeeping. Reported so a failure can name WHICH
   *  half broke — a stalled `framesPushed` is a dead pump, a moving one over a
   *  frozen surface is a dropped claim — but never asserted on ALONE, because
   *  "the host pushed" and "the device received" are different facts. */
  hasEntry: boolean;
  pumping: boolean;
  framesPushed: number;
  device: DeviceState | null;
}

async function openFullView(page: Page, id = OTL): Promise<void> {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(n),
    id,
  );
}

async function probe(page: Page, id = OTL): Promise<MonitorProbe> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __nodeLaunchpadMonitor(x: string): MonitorProbe })
        .__nodeLaunchpadMonitor(n),
    id,
  );
}

/** Write a param through the live Y.Doc, exactly as a control would. */
async function setParam(page: Page, nodeId: string, key: string, value: number): Promise<void> {
  await page.evaluate(
    ({ nodeId: id, key: k, value: v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[id];
        if (n) n.params[k] = v;
      });
    },
    { nodeId, key, value },
  );
}

/** A stable signature of what the SURFACE is showing. Two different pictures
 *  give two different strings; a frozen surface gives the same one forever. */
function surfaceSignature(d: DeviceState | null): string {
  if (!d) return 'no-device';
  return JSON.stringify({ lit: d.litIndices, p11: d.ledAt11, p99: d.ledAt99, mode: d.programmer });
}

test.describe('the Launchpad monitor OUTLIVES its card', () => {
  // A generous BOUNDED-FAILURE cap, not a budget. OUT TO LAUNCH downsamples a
  // real GL frame, and CI's SwiftShader runs the video lane an order of
  // magnitude slower than a GPU — every assertion below is an auto-retrying
  // poll on the real subject, never a wall-clock wait.
  test.describe.configure({ timeout: 120_000 });

  test('collapsing the expanded card leaves the surface LIT, CLAIMED and LIVE', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // DEFAULT shell (faceplates) — the configuration the bug needs. Under
    // `?shell=legacy` the card sits in the lane forever and never unmounts.
    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // A bright, frame-filling source so the 9×9 downsample is NOT all black —
    // a black grid would make every LED assertion below vacuous.
    await spawnPatch(
      page,
      [
        { id: SRC, type: 'shapes', position: { x: 40, y: 40 }, domain: 'video', params: { shape: 2, tile: 0, rotate: 0, zoom: 2.2 } },
        { id: OTL, type: 'outToLaunch', position: { x: 520, y: 40 }, domain: 'video' },
      ],
      [{ id: 'e1', from: { nodeId: SRC, portId: 'out' }, to: { nodeId: OTL, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' }],
    );

    // A FACED module under the shell: the lane renders `ModuleShell`, never the
    // legacy card. (Before the promotion this read "a placeholder tile, not the
    // real card" — the module was `bespoke-surface`, so the lane was a uniform
    // rackline tile with zero controls. Either way the card is not here; what
    // changed is that the tile now carries CONNECT and BRIGHT.)
    await expect(
      page.locator('[data-testid="out-to-launch-card"]'),
      'the shell renders the faceplate tile, not the real card',
    ).toHaveCount(0);

    // ── ARRANGE: a Launchpad that no clip-launcher unit has claimed. ──
    const outputId = await page.evaluate(
      () =>
        (globalThis as unknown as { __launchpadMonitorTestInstall(): Promise<string> })
          .__launchpadMonitorTestInstall(),
    );
    expect(outputId, 'the simulated Launchpad output port id').toBeTruthy();

    // EXPAND — the dock full-view, where the faceplate's binder body and its
    // pick/unbind controls live. Same call the tile's EXPAND button makes.
    await openFullView(page);
    const pane = page.locator('.dock-fullview-pane');
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId(BODY),
      'the faceplate binder body mounted in the dock full-view',
    ).toHaveCount(1);

    // BIND through the REAL face controls: the ranked CONNECT cell (which
    // short-circuits on the already-installed access, so no Web-MIDI prompt),
    // then pick the port from the body's roster.
    //
    // ⚠ CONNECT IS PRESSED ON THE LANE TILE, not in the pane, and that is the
    // gesture the promotion moved: it is an `action` cell, so it reaches every
    // tier, while the roster it fills can only live on a surface.
    await page
      .locator(`.svelte-flow__node[data-id="${OTL}"] [data-testid="module-shell"]`)
      .getByTestId('shell-cell-out-to-launch-connect')
      .click();
    const picker = page.getByTestId(`out-to-launch-binder-picker-${OTL}`);
    await expect(picker, 'the face enumerated the simulated Launchpad').toBeVisible({ timeout: 15_000 });
    await picker.locator('button').first().click();
    await expect(
      page.getByTestId(LAMP),
      'the MONITOR lamp is lit — the card banner\'s surviving form',
    ).toHaveAttribute('data-lit', '1');

    const bound = await probe(page);
    expect(bound.bound, `bindMonitor did not claim the device: ${JSON.stringify(bound)}`).toBe(true);
    expect(bound.outputId).toBe(outputId);
    expect(bound.device?.programmer, 'the device entered programmer mode').toBe(true);

    // The pump is delivering a real picture: the surface is LIT.
    await expect
      .poll(async () => (await probe(page)).device?.litIndices.length ?? 0, {
        message:
          'the monitor never lit a single LED — the ARRANGE failed (no GL frame, a black source, ' +
          'or a bind that did not take), so the spec cannot test what it exists for',
        timeout: 45_000,
      })
      .toBeGreaterThan(0);

    // ── POSITIVE CONTROL (permanent, not a warm-up). While the card IS
    // mounted, a graph change reaches the hardware. If this leg cannot go
    // green the probe is blind and every post-collapse assertion below would
    // pass for the wrong reason.
    const beforeControl = surfaceSignature((await probe(page)).device);
    await setParam(page, SRC, 'zoom', 0.15); // frame-filling -> a speck
    await expect
      .poll(async () => surfaceSignature((await probe(page)).device), {
        message: 'the probe cannot see a graph change even with the card mounted — it is blind',
        timeout: 45_000,
      })
      .not.toBe(beforeControl);

    // ── ACT: COLLAPSE the full view. This UNMOUNTS the binder body. ──
    //
    // ⚠ THE SUBJECT MOVED WITH THE PROMOTION, AND ASSERTING ON THE OLD ONE
    // WOULD HAVE BEEN VACUOUS. This line used to read `expect(
    // '[data-testid="out-to-launch-card"]').toHaveCount(0)` — "the real card
    // really did unmount" — which is the ARRANGE leg proving the collapse
    // actually did something. Once `outToLaunch` entered `STRICT_FACES` the card
    // never mounts on this shell at all, so that count is 0 before the click,
    // after it, and on a build where collapse is a no-op. It would have gone
    // GREEN AND BLIND and certified the next #1728: precisely the
    // precondition-is-the-defect class, fixed by re-pointing the SUBJECT at the
    // surface that genuinely comes and goes rather than by loosening anything.
    const atCollapse = await probe(page);
    await expect(page.getByTestId(BODY), 'ARRANGE: the body is mounted before the collapse').toHaveCount(1);
    await page.getByTestId('faceplate-collapse').click();
    await expect(page.getByTestId(BODY), 'the faceplate body really did unmount').toHaveCount(0);

    // ── ASSERT 1: THE CLAIM. `unbindMonitor` deletes the entry, which also
    // releases the surface to LAUNCHPAD CONTROL. This is the worse half.
    const afterCollapse = await probe(page);
    expect(
      afterCollapse.bound,
      `the collapse DROPPED the device claim — this is #1728. The surface is now free for ` +
        `LAUNCHPAD CONTROL to take, and nothing re-binds on remount. probe=${JSON.stringify(afterCollapse)}`,
    ).toBe(true);

    // ── ASSERT 2: THE SURFACE. The blank-all batch + exit-to-Live is what the
    // performer actually sees: a Launchpad that goes dark mid-set.
    expect(
      afterCollapse.device?.programmer,
      `the collapse handed the Launchpad back to LIVE mode: ${JSON.stringify(afterCollapse.device)}`,
    ).toBe(true);
    expect(
      afterCollapse.device?.litIndices ?? [],
      `the collapse BLANKED the physical surface (every LED written to 0,0,0). ` +
        `Lit before the collapse: ${JSON.stringify(atCollapse.device?.litIndices)}`,
    ).not.toEqual([]);

    // …and still lit a moment later — a teardown scheduled by the unmount (a
    // queued microtask, a deferred effect cleanup) would land after the
    // synchronous check above and read as a pass.
    await expect
      .poll(async () => (await probe(page)).device?.litIndices.length ?? 0, {
        message: 'the surface was blanked shortly AFTER the collapse — a deferred teardown',
        timeout: 5_000,
      })
      .toBeGreaterThan(0);

    // ── ASSERT 3: THE PUMP. A surviving claim with a dead pump leaves the
    // surface frozen on its last frame — visually indistinguishable from a
    // working monitor on a still source, and the reason #1574 documents that
    // the pump must move with the resource. Causal probe, identical to the
    // positive control above: change the graph, watch the HARDWARE follow.
    expect(
      afterCollapse.pumping,
      `the node's LED pump stopped when the card unmounted: ${JSON.stringify(afterCollapse)}`,
    ).toBe(true);
    const beforePump = surfaceSignature(afterCollapse.device);
    await setParam(page, SRC, 'zoom', 8);
    await expect
      .poll(async () => surfaceSignature((await probe(page)).device), {
        message:
          'the claim survived but the LEDs are FROZEN on the last frame the card pushed — ' +
          'the pump died with the card',
        timeout: 45_000,
      })
      .not.toBe(beforePump);

    // …and the device RECEIVED those frames. `framesPushed` alone would only
    // say the host tried; `framesReceived` is the surface's own count, so the
    // pair distinguishes "pushed into a void" from "delivered".
    const pumped = await probe(page);
    expect(pumped.framesPushed).toBeGreaterThan(afterCollapse.framesPushed);
    expect(
      pumped.device!.framesReceived,
      `the pump ran but nothing reached the device: ${JSON.stringify(pumped)}`,
    ).toBeGreaterThan(afterCollapse.device!.framesReceived);

    // ── Re-expanding adopts the LIVE binding, not a fresh unbound plate. ──
    await openFullView(page);
    await expect(
      page.getByTestId(LAMP),
      're-expanding showed a faceplate that had forgotten its bound Launchpad',
    ).toHaveAttribute('data-lit', '1', { timeout: 15_000 });
    // …and the UNBIND control is there, which is what makes the binding
    // RELEASABLE after a remount rather than merely visible.
    await expect(
      page.getByTestId(`out-to-launch-binder-unbind-${OTL}`),
      'and it offers the release control, so the claim is not a one-way trip',
    ).toBeVisible();

    // ── NEGATIVE CONTROL, IN SITU, and it is load-bearing. "Never unbinds" is
    // a trivially passing implementation of everything above, and it is its own
    // bug: a deleted module would leave a Launchpad stuck in programmer mode
    // with nothing driving it, unusable for control until a replug. The ONE
    // non-user event that still releases it is the node leaving the GRAPH.
    // Deleting through the Y.Doc covers every delete route at once (menu,
    // lasso, undo, a peer's CRDT delete, Clear, a patch load).
    await page.evaluate((n) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        delete w.__patch.nodes[n];
      });
    }, OTL);

    await expect
      .poll(async () => (await probe(page)).bound, {
        message:
          'deleting the node did NOT release the Launchpad — the registry holds the device for the ' +
          'life of the tab, which would also make every assertion above vacuous',
        timeout: 15_000,
      })
      .toBe(false);
    const released = await probe(page);
    expect(released.device?.programmer, 'the released device was handed back to Live mode').toBe(false);
    expect(released.device?.litIndices ?? ['unset'], 'the released device was blanked').toEqual([]);

    expect(errors, 'no page errors').toEqual([]);
  });
});
