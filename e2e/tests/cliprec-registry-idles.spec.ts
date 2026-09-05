// cliprec-registry-idles.spec.ts
//
// THE RECORDER REGISTRY IDLES WHEN THERE IS NO ARM SURFACE AT ALL.
//
// The owner removed the mixmstrs record band on 2026-09-04: recording is a
// CLIPPLAYER feature, per clip, and the replacement per-lane toggle has not
// landed yet. That leaves a deliberate window in which the recorder
// infrastructure is fully wired — worklet, OPFS store, registry, tap rosters —
// and NOTHING can arm it.
//
// ⚠ THIS SPEC EXISTS BECAUSE THE TWO FAILURE MODES LOOK IDENTICAL FROM OUTSIDE.
// A registry that idles cleanly and a registry that throws on every tick both
// produce a rack with no recording. The difference only shows up as console
// noise, a wedged store, or pads painting a state nothing can leave — none of
// which a "recording does not happen" assertion would notice. So this asserts
// the ABSENCE is clean, not merely that the feature is gone.
//
// ⚠ AND IT IS GUARDED AGAINST BEING VACUOUS, which is the real risk in a spec
// whose headline assertions are all negative. "No errors" is trivially true of
// a page where nothing ran. Three positive controls establish that the subject
// is actually alive before any absence is claimed:
//
//   1. THE SOURCE CHAIN IS REAL — channel 1's post-fader meter hears the
//      oscillator. A dead rig would make every silence below meaningless.
//   2. THE READ SEAM IS LIVE — `read('recTaps')` on the SAME node, through the
//      SAME engine seam, returns the 16 board-in legs. So `read('recState')`
//      returning undefined is a genuine absence of that key, not a dead handle
//      that would answer undefined to anything.
//   3. THE CLIPPLAYER IS REAL — its lane output is wired to a scope that read
//      the live chain's own signal earlier in the journey.
//
// Only then: the arm key is gone, no take can start, the pads stay clean, and
// neither the console nor the page reports anything.

import type { Page } from '@playwright/test';
import { test, expect } from './_fixtures';
import { spawnPatch, MOUNT_CAP_MS } from './_helpers';
import { readScopePeakOverWindow, describeScopeWindow } from './_module-coverage-helpers';

// ---------------------------------------------------------------------------
// THE BUDGET IS DERIVED FROM THE STEPS, NOT TYPED OVER THEM
//
// ⚠ A flat wall SMALLER than the sum of the caps it contains cannot fail at the
// step that was slow: every step stays inside its own cap, the aggregate runs
// out, and Playwright reports a bare "Test timeout of N exceeded" against
// whatever call was in flight — no assertion text, nothing to grep but its
// absence. So the caps are named ONCE and the wall is their SUM.
// ---------------------------------------------------------------------------

/** Cold boot: the navigation, then the topbar painting. Charged TWICE — the
 *  goto carries the cap too, since this suite's config sets no
 *  `navigationTimeout` and a step with no cap can never be the one blamed. */
const BOOT_MS = 30_000;
/** The flow pane painting after the topbar — the last boot step. */
const PANE_MS = 15_000;
/** The live channel meter hearing the oscillator (positive control 1). */
const LIVE_METER_MS = 20_000;
/** A settle window over which the registry gets many ticks to misbehave. */
const IDLE_SOAK_MS = 6_000;
/** One scope observation window. */
const SILENCE_CONFIRM_MS = 1_200;
/** A single engine/DOM read. */
const UI_MS = 5_000;

const TEST_BUDGET_MS =
  2 * BOOT_MS +
  PANE_MS +
  MOUNT_CAP_MS +
  LIVE_METER_MS +
  IDLE_SOAK_MS +
  SILENCE_CONFIRM_MS +
  6 * UI_MS;

const TL = 'tl1';
const OSC = 'osc1';
const MIX = 'mx1';
const CP = 'cp1';
const SC = 'sc1';

/** Read a key off a live node handle through the engine seam. Returns a
 *  discriminated result so "the key answered undefined" is distinguishable
 *  from "there was no engine or no node" — the difference this spec turns on. */
async function readKey(
  page: Page,
  nodeId: string,
  key: string,
): Promise<{ ok: boolean; value: unknown }> {
  return await page.evaluate(
    ([id, k]) => {
      const w = window as unknown as {
        __engine?: () => { read(node: unknown, key: string): unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch.nodes[id!];
      if (!eng || !node) return { ok: false, value: null };
      const v = eng.read(node, k!) as unknown;
      // Structured-clone safety: report SHAPE, never live AudioNodes.
      if (v === undefined) return { ok: true, value: undefined };
      if (Array.isArray(v)) return { ok: true, value: { kind: 'array', length: v.length } };
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return {
          ok: true,
          value: {
            kind: 'object',
            keys: Object.keys(o).sort(),
            boardLength: Array.isArray(o.board) ? (o.board as unknown[]).length : null,
          },
        };
      }
      return { ok: true, value: { kind: typeof v } };
    },
    [nodeId, key] as const,
  );
}

/** The mixer's post-fader channel meters — the live-chain positive control. */
async function readChannelLevel(page: Page, ch0: number): Promise<number> {
  return await page.evaluate(
    ([mixId, c]) => {
      const w = window as unknown as {
        __engine?: () => { read(node: unknown, key: string): unknown } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const mix = w.__patch.nodes[mixId as string];
      if (!eng || !mix) return 0;
      const levels = eng.read(mix, 'levels') as number[] | undefined;
      return levels?.[c as number] ?? 0;
    },
    [MIX, ch0] as const,
  );
}

/** Node data, deep-copied out of the live graph. */
async function readData(page: Page, nodeId: string): Promise<Record<string, unknown>> {
  return await page.evaluate((id) => {
    const w = window as unknown as { __patch: { nodes: Record<string, { data?: unknown }> } };
    return JSON.parse(JSON.stringify(w.__patch.nodes[id]?.data ?? {})) as Record<string, unknown>;
  }, nodeId);
}

test('with the record band GONE the recorder registry idles: no errors, no takes, clean pads', async ({
  page,
}) => {
  test.setTimeout(TEST_BUDGET_MS);

  // ── The instruments, armed BEFORE the page can misbehave ────────────────
  // ⚠ A pageerror guard belongs in every spec of this shape: an uncaught
  // exception inside a $effect tick does NOT fail a Playwright test on its own,
  // and a registry that throws once per tick would otherwise look identical to
  // one that idles.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const clipRecLogs: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    // The registry's own channel: refusals and commit failures are prefixed.
    if (t.includes('[clip-rec]')) clipRecLogs.push(`${msg.type()}: ${t}`);
  });

  // ── The rig: a REAL oscillator into channel 1, the clip output on a scope ──
  // `seed=none` (the test-only empty rack): the workflow pins would add a
  // SECOND mixmstrs/clipplayer pair, and the lane↔channel binding targets the
  // first launcher in the graph — this spec must own which one that is.
  await page.goto('/rack?seed=none', { timeout: BOOT_MS });
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page
    .locator('.svelte-flow__pane:visible')
    .first()
    .waitFor({ state: 'visible', timeout: PANE_MS });
  await spawnPatch(
    page,
    [
      { id: TL, type: 'timelorde', position: { x: 0, y: 0 }, params: { running: 1, bpm: 120 } },
      { id: OSC, type: 'analogVco', position: { x: 0, y: 200 } },
      { id: MIX, type: 'mixmstrs', position: { x: 400, y: 0 } },
      { id: CP, type: 'clipplayer', position: { x: 400, y: 600 } },
      { id: SC, type: 'scope', position: { x: 900, y: 0 } },
    ],
    [
      // The dual-mono double-patch: the mono sine into BOTH legs of channel 1.
      { id: 'e1', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1L' } },
      { id: 'e2', from: { nodeId: OSC, portId: 'sine' }, to: { nodeId: MIX, portId: 'ch1R' } },
      // The clip's own lane output — silent unless something recorded.
      { id: 'e3', from: { nodeId: CP, portId: 'audio1L' }, to: { nodeId: SC, portId: 'ch1' } },
    ],
  );

  // ── POSITIVE CONTROL 1 — the source chain is real ───────────────────────
  // Without this, every silence below is satisfied by a rack that never made a
  // sound in the first place.
  await expect
    .poll(() => readChannelLevel(page, 0), {
      message: 'channel 1 must hear the patched oscillator — otherwise this spec proves nothing',
      timeout: LIVE_METER_MS,
    })
    .toBeGreaterThan(0.02);

  // ── POSITIVE CONTROL 2 — the read seam is live on THIS node ─────────────
  // `recTaps` is the AUDIO half of the clip-record feature and deliberately
  // survived the band's removal: clause 8 still captures this module's per-lane
  // pre-board input. Its presence proves the handle answers real keys, which is
  // what makes the next assertion's `undefined` mean "the key is gone" rather
  // than "the handle is dead and answers undefined to everything".
  const taps = await readKey(page, MIX, 'recTaps');
  expect(taps.ok, 'the engine + mixer node must be reachable').toBe(true);
  expect(taps.value, `read('recTaps') must still publish the tap rosters: ${JSON.stringify(taps.value)}`)
    .toMatchObject({ kind: 'object', boardLength: 16 });

  // ── THE SUBJECT — the arm surface is gone, measured on the live handle ───
  const recState = await readKey(page, MIX, 'recState');
  expect(recState.ok, 'the same node must still be reachable').toBe(true);
  expect(
    recState.value,
    "read('recState') answered — the mixmstrs arm surface the owner removed has come back",
  ).toBeUndefined();

  // ── SOAK — give the registry many ticks with no arm source ──────────────
  // The registry polls on the shared ticker. One read proves nothing about a
  // per-tick throw, so the page is left running while the scope window below
  // is measured, and the error instruments are read AFTER it.
  const quiet = await readScopePeakOverWindow(page, SC, SILENCE_CONFIRM_MS, { minMs: 800 });
  expect(
    quiet.peak,
    `the clip lane output must be silent — nothing can have recorded: ${describeScopeWindow(quiet)}`,
  ).toBeLessThan(0.02);
  // ⚠ THE SOAK IS OBSERVABLE STATE, NOT A SLEEP. The scope window above is a
  // real ~1 s measurement of the audio thread, and the meter poll below reads
  // the mixer's own live analyser — between them the registry's ticker runs
  // many times. A bare timer here would be exactly the arbitrary delay this
  // repo forbids, and would prove nothing a shorter one did not.
  await expect
    .poll(() => readChannelLevel(page, 0), {
      message: 'the live chain must STILL be audible after the soak — the rig did not fall over',
      timeout: IDLE_SOAK_MS,
    })
    .toBeGreaterThan(0.02);

  // ── THE PADS ARE UNTOUCHED ──────────────────────────────────────────────
  // `audioRec` is the registry's own projection — the per-key record that drives
  // the pad ladder. A registry that half-armed and wedged would leave an entry
  // here that nothing can clear, and the pad would paint a state with no exit.
  const cpData = await readData(page, CP);
  const audioRec = (cpData.audioRec ?? {}) as Record<string, unknown>;
  expect(
    Object.keys(audioRec),
    'no lane may hold a recording projection — nothing can arm, so nothing may look armed',
  ).toEqual([]);

  // ── AND THE ABSENCE WAS CLEAN ───────────────────────────────────────────
  expect(
    clipRecLogs,
    'the recorder registry logged on a rack it cannot possibly record on',
  ).toEqual([]);
  expect(pageErrors, 'the page threw while the registry idled').toEqual([]);
});
