// e2e/tests/treeohvox-strike.spec.ts
//
// THE ONE ASSERTION THAT COULD NOT BE MADE ANYWHERE ELSE: that TREE.oh.VOX CAN
// BE SOUNDED BY HAND.
//
// TREE.oh.VOX is a 303 VOICE with no internal exciter: `gate_in` is the only
// thing that starts a note. It shipped with no gate affordance on any surface,
// which was FILED as read-off-the-tree (#1658) and then MEASURED here, on the
// shipping module, in this browser, before a line of the fix was written:
//
//   * legacy card, nothing patched, all TWENTY-FIVE pressables clicked
//     (name label, both patch triggers, the eleven jacks, the knobs)
//        → `audio_out` peak 0.000e+0 over 145 accumulated frames
//   * default rack's shell face AND its dock full-view, same treatment
//        → 0.000e+0 over 146 frames
//   * `engine.read(node, 'manualTrigger' | 'manualGate')` → BOTH undefined
//   * POSITIVE CONTROL, same analyser, same page: a sequencer gate into
//     `gate_in` → peak 3.390e-1 over 182 frames
//
// The zero was the module, not the instrument. That is the rings/sixstrum class
// verbatim, and this spec is the regression that would have caught it.
//
// ⚠ WHY AN AUDIO TAP AND NOT JUST THE LEDGER. `delivered: true` proves the press
// reached a callable; it does not prove the callable makes a NOISE. The defect
// this module actually had was inaudibility, so the headline legs assert PEAK on
// `audio_out` and the ledger is the corroborating read. Both directions of the
// instrument are permanent legs here: the sequencer-gated positive control (a
// zero must be attributable to the module, never to a dead analyser) and the
// broken-seam negative control (a non-zero must be attributable to the press).
//
// ⚠ AND THE ACCUMULATOR LIVES IN THE PAGE. A Playwright-side poll loop is one
// round-trip per sample on the SAME main thread as the subject, so a loaded
// runner starves both and "silent" becomes indistinguishable from "never
// looked". Every measurement below reports its own `samples` count.
//
// What is NOT here, because it is covered and duplicating it would be CI
// wall-time for nothing: the host-side wiring (`treeohvox-factory-strike.test
// .ts`, 9 legs on the REAL factory), the DSP (`treeohvox-dsp.test.ts` &c), and
// the gated-from-a-cable path (`per-module-per-port`).

import { test, expect, type Locator, type Page } from '@playwright/test';
import { spawnPatch, type SpawnEdge, type SpawnNode } from './_helpers';

const SLOW = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const NID = 'tv-strike-1';

/** The `_drivers.ts` treeohvox params — a gated note is comfortably audible
 *  with these (open cutoff, long-ish decay), so a zero is the gate's fault. */
const AUDIBLE = { cutoff: 2500, resonance: 0.5, envelope: 0.7, decay: 800, accent: 0.5 };

/** The repo's "this output is alive" floor, the same one `per-module.spec.ts`
 *  uses. The measured gated peak is 3.390e-1, ~68× over it. */
const ALIVE_PEAK = 0.005;

interface Probe { an: AnalyserNode }

interface AuditionRecord {
  seq: number;
  nodeId: string;
  seam: 'manual-strike' | 'manual-gate' | 'engine-message' | 'manual-press';
  high?: boolean;
  delivered: boolean;
}

function readAuditionLog(page: Page): Promise<AuditionRecord[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __auditionLog?: () => AuditionRecord[] };
    return w.__auditionLog ? w.__auditionLog() : [];
  });
}

const lastSeq = (log: AuditionRecord[]): number => log.reduce((m, r) => Math.max(m, r.seq), 0);

/** Every `manual-gate` record for this node since `sinceSeq`, delivered or not.
 *  The distinction between "no record" and "a record saying it reached nothing"
 *  is the one the ledger exists to preserve. */
const gateAttempts = (log: AuditionRecord[], sinceSeq: number): AuditionRecord[] =>
  log.filter((r) => r.seq > sinceSeq && r.nodeId === NID && r.seam === 'manual-gate');

async function goto(page: Page, query: string): Promise<void> {
  await page.goto(`/rack${query}`);
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: SLOW ? 30_000 : 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Hang an analyser on treeohvox's `audio_out`, via the same output seam a
 *  cable materialises through. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate((nid) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain(d: string): {
          getOutputNode(nodeId: string, portId: string): { node: AudioNode; output: number } | null;
        };
      };
    };
    const ref = w.__engine().getDomain('audio').getOutputNode(nid, 'audio_out');
    if (!ref) throw new Error('`audio_out` has no audio node — the probe never attached');
    const ctx = ref.node.context as AudioContext;
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    ref.node.connect(an, ref.output);
    (w as unknown as { __tvProbe: Probe }).__tvProbe = { an };
  }, NID);
}

/**
 * Peak-hold `audio_out` for `ms`, accumulating IN THE PAGE. Reports its own
 * sample count so "silent" and "never sampled" can never be confused.
 */
async function measure(page: Page, ms: number): Promise<{ peak: number; samples: number }> {
  return page.evaluate(
    (ms) =>
      new Promise<{ peak: number; samples: number }>((resolve) => {
        const p = (globalThis as unknown as { __tvProbe: Probe }).__tvProbe;
        const buf = new Float32Array(p.an.fftSize);
        let peak = 0, samples = 0;
        const t0 = performance.now();
        const tick = () => {
          p.an.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]!); if (a > peak) peak = a; }
          samples++;
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else resolve({ peak, samples });
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/** Units are stated in the message on purpose — `peak` is a linear sample
 *  amplitude on `audio_out`, not dB and not RMS. */
const report = (what: string, m: { peak: number; samples: number }): string =>
  `${what}: peak=${m.peak.toExponential(3)} (linear sample amplitude on audio_out) over ${m.samples} accumulated frames`;

/** Press-and-HOLD the pad the way a finger does. `dispatchEvent` rather than
 *  `mouse.down()` because the hold has to survive us doing other work, and a
 *  real pointer would drift off the element (the bluebox push-to-talk idiom). */
async function padDown(pad: Locator): Promise<void> {
  await pad.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0 });
}
async function padUp(pad: Locator): Promise<void> {
  await pad.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0 });
}

async function spawnAlone(page: Page): Promise<void> {
  await spawnPatch(page, [{ id: NID, type: 'treeohvox', position: { x: 240, y: 200 }, params: AUDIBLE }]);
  await installProbe(page);
}

/**
 * Wait until the voice has actually gone quiet, and REPORT what it took.
 *
 * ⚠ THIS IS NOT PACING, IT IS A MEASUREMENT — and it is load-bearing for the
 * negative control. The 303's amp envelope has a fixed ~1.2 s decay, so a
 * released note is still ringing well after the pointerup; measuring the
 * severed-seam press on top of that tail read peak 1.404e-1 and failed a leg
 * whose subject was supposed to be silence. Polling the REAL subject (the
 * in-page accumulator) rather than sleeping a guessed interval means this
 * cannot go stale when the envelope changes, and the returned peak is
 * asserted by the caller — so "the release ends the note" is itself under test
 * instead of assumed.
 */
async function settleToSilence(page: Page, capMs = 6000): Promise<{ peak: number; waitedMs: number }> {
  const t0 = Date.now();
  let peak = Number.POSITIVE_INFINITY;
  while (Date.now() - t0 < capMs) {
    peak = (await measure(page, 250)).peak;
    if (peak < ALIVE_PEAK) break;
  }
  return { peak, waitedMs: Date.now() - t0 };
}

test.describe('treeohvox — THE AUDITION (the voice could not be sounded before it)', () => {
  test('the CARD gate pad SOUNDS the voice — held high, and silent before the press', async ({ page }) => {
    // `?shell=legacy` is the surface this defect was theirs first, and it is
    // now the ONLY surface this pad appears on. It used to be both: while
    // treeohvox had no curated face the dock full-view rendered this same card
    // (measured then — `dock-full-view` contained one `.mod-card`). Since the
    // promotion (#1944) the dock renders the FACEPLATE, so the two surfaces are
    // two components and the leg below tests the other one.
    //
    // This leg is kept rather than folded into that one: `?shell=legacy` is a
    // shipped escape hatch, so the card remains a surface a player can reach,
    // and it is the surface every assertion in #1658 was originally measured on.
    await goto(page, '?shell=legacy&seed=none');
    await spawnAlone(page);

    // AT REST it must be silent, or "the pad works" could be the module simply
    // free-running. Measured 0.000e+0 on the shipping module.
    const rest = await measure(page, 500);
    expect(rest.samples, 'the accumulator must have run').toBeGreaterThan(5);
    expect(rest.peak, report('unpatched and unpressed', rest)).toBeLessThan(ALIVE_PEAK);

    const pad = page.getByTestId(`treeohvox-gate-${NID}-1`);
    await expect(pad, 'the card carries a GATE pad').toBeVisible();
    await expect(pad).toBeEnabled();
    await expect(pad, 'it rests released').toHaveAttribute('aria-pressed', 'false');

    const before = lastSeq(await readAuditionLog(page));
    await padDown(pad);
    await expect(pad, 'a held pad reports itself held').toHaveAttribute('aria-pressed', 'true');

    const held = await measure(page, 900);
    await padUp(pad);

    expect(held.samples, 'the accumulator must have run').toBeGreaterThan(5);
    expect(
      held.peak,
      report('GATE pad HELD, nothing patched', held) +
        ' — this is the whole feature: a 303 voice with no exciter and no surface ' +
        'that can excite it is a module nobody can play (#1658).',
    ).toBeGreaterThan(ALIVE_PEAK);

    // BOTH EDGES must have reached the engine. A gate that opens and never
    // closes is the worst failure this seam has, and a one-edge probe is blind
    // to exactly it.
    const edges = gateAttempts(await readAuditionLog(page), before);
    expect(edges.map((r) => `${r.high ? 'hi' : 'lo'}:${r.delivered}`), 'press then release, both delivered')
      .toEqual(['hi:true', 'lo:true']);
    await expect(pad, 'the release un-holds the pad').toHaveAttribute('aria-pressed', 'false');
  });

  test('the DOCK FACEPLATE carries its OWN gate cell, and it delivers there too', async ({ page }) => {
    // ⚠ THIS TEST'S SUBJECT CHANGED WITH THE PROMOTION (#1944), and the change
    // is the point rather than maintenance. It used to read:
    //
    //   "for a module with no curated face the dock full-view is the legacy
    //    card … treeohvox has no curated face, and its canvas node carries
    //    `shell-open-dock` without one (measured — the `module-shell` locator
    //    matches 0 elements here)"
    //
    // Both premises were TRUE and are now FALSE: treeohvox is in STRICT_FACES,
    // so `DockFullView` renders `<ModuleShell view="dock-full">` INSTEAD of
    // `TreeohvoxCard.svelte`. The old locator (`treeohvox-gate-<id>-1`) is the
    // CARD's family testid, which `ModuleShell` deliberately does not emit —
    // `cellTestId` returns `shell-cell-<familyId>` precisely so the two
    // surfaces cannot be confused for one another. So this test went RED on the
    // promotion rather than green-and-blind, which is the outcome the def's own
    // note to the faceplate author predicted, and it is re-pointed at the
    // surface that now exists rather than "fixed" by relaxing it.
    //
    // It is STRICTLY STRONGER than the version it replaces. Before, the dock
    // leg and the card leg exercised the SAME component through the same
    // testid, so the dock leg proved only that the card could be reached from
    // the dock. Now it proves the FACE — a different component, a different
    // cell, resolving `setManualGate` through `shell-cells.ts` — can sound the
    // voice. That is exactly the sixstrum defect's habitat: a promoted module
    // whose card button still works while its FACE offers controls over an
    // instrument nobody can hear.
    await goto(page, '?seed=none');
    await spawnAlone(page);

    const expand = page.locator(`.svelte-flow__node[data-id="${NID}"] [data-testid="shell-open-dock"]`);
    await expect(expand, 'the canvas node offers a way into the dock').toBeVisible();
    await expand.click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible();

    // The faceplate, NOT the card — asserted rather than assumed, so that a
    // regression to the legacy card in the dock is a named failure here instead
    // of an invisible change of subject.
    await expect(
      dock.getByTestId('module-shell'),
      'the promoted module must render its FACEPLATE in the dock, not its card',
    ).toBeVisible();
    await expect(
      dock.locator('.mod-card'),
      'and the legacy card must be gone from this surface',
    ).toHaveCount(0);

    const pad = dock.getByTestId('shell-cell-treeohvox-gate');
    await expect(pad, 'the dock FACEPLATE offers a way to sound the voice').toBeVisible();

    const before = lastSeq(await readAuditionLog(page));
    await padDown(pad);
    const held = await measure(page, 900);
    await padUp(pad);

    expect(held.peak, report('dock GATE pad HELD', held)).toBeGreaterThan(ALIVE_PEAK);
    expect(
      gateAttempts(await readAuditionLog(page), before).map((r) => `${r.high ? 'hi' : 'lo'}:${r.delivered}`),
    ).toEqual(['hi:true', 'lo:true']);
  });

  test('NEGATIVE CONTROL — with the seam broken the pad is SILENT and records delivered:false', async ({ page }) => {
    // ⚠ WITHOUT THIS LEG THE TWO ABOVE PROVE LESS THAN THEY LOOK. `toBeVisible`,
    // `toBeEnabled` and a click all pass against a pad wired to nothing — that
    // is the sixstrum defect exactly. This drives the SAME pad with the engine
    // made unable to answer `manualGate`, and requires BOTH observables to
    // invert: the ledger records the attempt as undelivered, and the audio tap
    // goes back to the pre-fix zero.
    await goto(page, '?shell=legacy&seed=none');
    await spawnAlone(page);
    const pad = page.getByTestId(`treeohvox-gate-${NID}-1`);
    await expect(pad).toBeVisible();

    // Baseline FIRST, so a failure below is the perturbation and not a bad spawn.
    await padDown(pad);
    const baseline = await measure(page, 900);
    await padUp(pad);
    expect(baseline.peak, report('baseline before the perturbation', baseline)).toBeGreaterThan(ALIVE_PEAK);

    // …and let that note END before measuring silence, or the leg below reads
    // the baseline's own ~1.2 s decay tail and calls it "the pad still works"
    // (measured: 1.404e-1). This doubles as the assertion that RELEASING the
    // pad actually stops the voice.
    const settled = await settleToSilence(page);
    expect(
      settled.peak,
      `after releasing the pad the voice must fall silent — peak=${settled.peak.toExponential(3)} ` +
        `(linear amplitude on audio_out) still ringing after ${settled.waitedMs} ms. A gate that ` +
        `opens and never closes is a note that never ends.`,
    ).toBeLessThan(ALIVE_PEAK);

    // BREAK IT AT EXACTLY THE POINT THE PAD DEPENDS ON — `read(node, key)` is
    // what `resolveManualGate` calls, so this cannot drift out of relevance
    // without the seam itself changing. Patching `read` rather than engine
    // internals also means it cannot silently no-op: a negative control that
    // fails to apply would leave both tests above vacuous, so its application
    // is asserted.
    const broke = await page.evaluate(() => {
      // ⚠ `__engine` is a GETTER (`() => engine`), not the engine — Canvas.svelte.
      const w = globalThis as unknown as {
        __engine?: () => { read?: (n: unknown, k: string) => unknown } | undefined;
      };
      const eng = typeof w.__engine === 'function' ? w.__engine() : undefined;
      if (!eng || typeof eng.read !== 'function') return false;
      const orig = eng.read.bind(eng);
      eng.read = (n: unknown, k: string) => (k === 'manualGate' ? undefined : orig(n, k));
      return true;
    });
    expect(
      broke,
      'the perturbation must APPLY — a negative control that cannot run is not a negative control',
    ).toBe(true);

    const before = lastSeq(await readAuditionLog(page));
    await padDown(pad);
    const dead = await measure(page, 900);
    await padUp(pad);

    const attempts = gateAttempts(await readAuditionLog(page), before);
    expect(attempts.length, 'a press that reaches nothing must still be RECORDED, never dropped')
      .toBeGreaterThan(0);
    expect(
      attempts.every((r) => r.delivered === false),
      'with the handle gone the ledger must record delivered:false — if this reads true the ' +
        'probe cannot tell a working audition from a dead one',
    ).toBe(true);
    expect(
      dead.peak,
      report('pad pressed with the seam severed', dead) +
        ' — this is the pre-fix number, and it must come back when the seam is cut, ' +
        'or the audio leg above is measuring something other than this pad',
    ).toBeLessThan(ALIVE_PEAK);
  });

  test('PERMANENT POSITIVE CONTROL — a real sequencer gate still sounds it (a zero is the module, not the analyser)', async ({ page }) => {
    // The instrument's other direction, kept permanently: every "silent"
    // assertion above is only worth what this leg is worth. It also pins the
    // property the audition must not break — the pad SUMS into `gate_in`, so a
    // patched cable keeps working alongside it.
    await goto(page, '?seed=none');
    const nodes: SpawnNode[] = [
      { id: 'seq', type: 'sequencer', position: { x: 60, y: 280 }, params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
      { id: NID, type: 'treeohvox', position: { x: 400, y: 120 }, params: AUDIBLE },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_g', from: { nodeId: 'seq', portId: 'gate' }, to: { nodeId: NID, portId: 'gate_in' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_p', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: NID, portId: 'pitch_in' }, sourceType: 'pitch', targetType: 'cv' },
    ];
    await spawnPatch(page, nodes, edges);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const seq = w.__patch.nodes['seq'];
        if (!seq) return;
        if (!seq.data) seq.data = {};
        seq.data.steps = [{ on: true, midi: 48 }, { on: true, midi: 50 }, { on: true, midi: 52 }, { on: true, midi: 55 }];
      });
    });
    await installProbe(page);

    const m = await measure(page, 1500);
    expect(m.samples, 'the accumulator must have run').toBeGreaterThan(10);
    expect(m.peak, report('sequencer gate patched into gate_in', m)).toBeGreaterThan(ALIVE_PEAK);
  });
});
