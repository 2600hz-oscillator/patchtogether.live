// e2e/tests/clip-automation.spec.ts
//
// CLIP-LAUNCHER AUTOMATION LANE — the real UI drive (task #183). Proves the
// whole workflow end-to-end against the live app + engine, gating all timing on
// the clip transport (the automation lane's own playhead) so nothing races the
// wall clock.
//
// The observable for "playback drives the param" is engine.readParam(node,pid):
// the automation playback path writes each scheduled value into the engine's
// knobValues cache (engine.scheduleParam), and readParam reads that cache — so a
// param under automation VARIES over a loop, while a SUSPENDED (live-grabbed)
// param stays put. Store writes are separate (playback is zero-Yjs), so reading
// the store would show nothing; we read the ENGINE.
//
// Record model (owner, 2026-07-15): ARM punches in at the automation clip's OWN
// next loop wrap, then OVERDUBS every loop (commit per wrap, keep going) until you
// press ARM again to STOP. Only params you moved that pass merge in; untouched
// tracks keep theirs. A 🟡🟡🔴🔴 countdown flashes the AUTO button + the clip cell
// in the last four beats before the wrap.
//
// Cases:
//   1. Create (+AUTO) → assign a knob via the context MENU → arm → move the knob
//      across ≥2 loops (continuous overdub commits each wrap; still armed) → the
//      AUTO button flashes the 🟡→🔴 countdown → DISARM → playback drives the param.
//   2. MULTIPLE params over passes + move-detection: move two, leave a third (with
//      prior automation) untouched → both moved commit breakpoints and play back
//      independently; the untouched one keeps its prior automation.
//   3. SCREEN-touch suspends only the grabbed param ("live wins"); the other
//      keeps playing; re-enable indicator resumes it.
//   4. MIDI-twist suspends only the twisted param via the SAME seam; the other
//      keeps playing; re-enable resumes it.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { waitForSoundingStep } from './_scheduler-control';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const CP = 'cp';
// The "+AUTO" cell is lane 7 (CLIP_LANES-1), slot 0. The flat clip key is
// stride-64 (schema v2): clipIndex(0, 7) = 7*64 + 0 = 448.
const AUTO_IDX = 448;
const AUTO_LANE = 7;
// A short clip → ~1s loops at 120bpm / 1/16 (fast, deterministic record + poll).
const CLIP_LEN = 8;

// ── engine / store helpers ───────────────────────────────────────────────────

/** The engine's live param value (knobValues cache — updated by automation
 *  playback's scheduleParam AND by user setParam). */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | null> {
  return page.evaluate(
    ([id, p]) => {
      const w = globalThis as unknown as {
        __engine?: () => { readParam: (n: unknown, p: string) => number | undefined } | null;
        __patch: { nodes: Record<string, unknown> };
      };
      const eng = w.__engine?.();
      const node = w.__patch?.nodes?.[id];
      if (!eng || !node) return null;
      const v = eng.readParam(node, p);
      return typeof v === 'number' ? v : null;
    },
    [nodeId, paramId] as const,
  );
}

/** Sample a param N times and report min/max/spread (a rough loop window). */
async function sampleSpread(
  page: Page,
  nodeId: string,
  paramId: string,
  count = 14,
  intervalMs = 70,
): Promise<{ vals: number[]; spread: number }> {
  const vals: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = await readParam(page, nodeId, paramId);
    if (v != null) vals.push(v);
    await page.waitForTimeout(intervalMs);
  }
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  return { vals, spread };
}

/** Sample TWO params in lock-step; returns the max |a-b| seen (independence). */
async function sampleDivergence(
  page: Page,
  a: string,
  b: string,
  paramId: string,
  count = 14,
  intervalMs = 70,
): Promise<number> {
  let maxDiff = 0;
  for (let i = 0; i < count; i++) {
    const [va, vb] = await Promise.all([readParam(page, a, paramId), readParam(page, b, paramId)]);
    if (va != null && vb != null) maxDiff = Math.max(maxDiff, Math.abs(va - vb));
    await page.waitForTimeout(intervalMs);
  }
  return maxDiff;
}

/** Force the transport running (set running=1 on any TIMELORDE; free-run
 *  otherwise, where the clipplayer treats "no transport" as running). */
async function ensureTransportRunning(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { type?: string; params: Record<string, number> }> };
    };
    w.__ydoc.transact(() => {
      for (const n of Object.values(w.__patch.nodes)) {
        if (n.type === 'timelorde') { n.params.running = 1; n.params.bpm = 120; }
      }
    });
  });
}

type SeedTrack = { nodeId: string; paramId: string; events: { step: number; value: number }[] };

/** Seed the automation clip (pointer + tracks) directly into the store — the
 *  deterministic path for the suspension/multi-param behaviour tests. */
async function seedAutomationClip(page: Page, tracks: SeedTrack[], len = CLIP_LEN): Promise<void> {
  await page.evaluate(
    ({ idx, lane, tracks, len }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      w.__ydoc.transact(() => {
        const node = w.__patch.nodes['cp'];
        if (!node.data) node.data = {};
        const data = node.data as { clips?: Record<string, unknown>; automation?: Record<string, unknown> };
        if (!data.clips) data.clips = {};
        data.clips[String(idx)] = {
          kind: 'automation',
          lengthSteps: len,
          loop: true,
          tracks: tracks.map((t) => ({ target: { nodeId: t.nodeId, paramId: t.paramId }, events: t.events })),
        };
        if (!data.automation) data.automation = {};
        data.automation.clip = { lane, slot: 0 };
      });
    },
    { idx: AUTO_IDX, lane: AUTO_LANE, tracks, len },
  );
}

/** Read a summary of the automation clip's tracks (for record assertions). */
async function readClipTracks(
  page: Page,
): Promise<Array<{ nodeId: string; paramId: string; events: { step: number; value: number }[] }>> {
  return page.evaluate((idx) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { clips?: Record<string, unknown> } }> };
    };
    const clip = w.__patch?.nodes?.['cp']?.data?.clips?.[String(idx)] as
      | { tracks?: Array<{ target?: { nodeId?: string; paramId?: string }; events?: Array<{ step?: number; value?: number }> }> }
      | undefined;
    const tracks = clip?.tracks;
    if (!tracks) return [];
    const out: Array<{ nodeId: string; paramId: string; events: { step: number; value: number }[] }> = [];
    for (let ti = 0; ti < tracks.length; ti++) {
      const t = tracks[ti]!;
      const events: { step: number; value: number }[] = [];
      const evs = t.events ?? [];
      for (let ei = 0; ei < evs.length; ei++) events.push({ step: Number(evs[ei]!.step), value: Number(evs[ei]!.value) });
      out.push({ nodeId: String(t.target?.nodeId), paramId: String(t.target?.paramId), events });
    }
    return out;
  }, AUTO_IDX);
}

/** The synced automation arm flag (node.data.automation.arm). */
async function isArmed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { automation?: { arm?: boolean } } }> };
    };
    return w.__patch?.nodes?.['cp']?.data?.automation?.arm === true;
  });
}

/** Set a clip's lengthSteps + div in place. The +AUTO default is LONG + SLOW (a
 *  32s loop) — tests shrink it to a fast, deterministic loop. `div=3` = '1' (the
 *  fastest non-multiplying rate; on the 1/16 STEP grid a step is ~125ms). */
async function setAutoClip(page: Page, len: number, div = 3): Promise<void> {
  await page.evaluate(
    ({ idx, len, div }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { data?: { clips?: Record<string, { lengthSteps?: number; div?: number }> } }> };
      };
      w.__ydoc.transact(() => {
        const clip = w.__patch.nodes['cp']?.data?.clips?.[String(idx)];
        if (clip) { clip.lengthSteps = len; clip.div = div; }
      });
    },
    { idx: AUTO_IDX, len, div },
  );
}

/** The AUTO button's live countdown colour ('yellow' | 'red' | null) — the card
 *  mirror of the published render state (its cd-yellow / cd-red classes). */
async function autoCountdownColor(page: Page): Promise<'yellow' | 'red' | null> {
  return page.evaluate((cp) => {
    const btn = document.querySelector(`[data-testid="clipplayer-auto-arm-${cp}"]`);
    if (!btn) return null;
    if (btn.classList.contains('cd-red')) return 'red';
    if (btn.classList.contains('cd-yellow')) return 'yellow';
    return null;
  }, CP);
}

/** Poll the AUTO countdown colour for `ms`, returning the ORDERED sequence of
 *  distinct colours observed (e.g. ['yellow','red']) — proves the 🟡→🔴 order. */
async function collectCountdown(page: Page, ms: number): Promise<Array<'yellow' | 'red'>> {
  const seq: Array<'yellow' | 'red'> = [];
  const start = Date.now();
  while (Date.now() - start < ms) {
    const c = await autoCountdownColor(page);
    if (c && seq[seq.length - 1] !== c) seq.push(c);
    await page.waitForTimeout(60);
  }
  return seq;
}

/** Launch the automation clip (last-lane pad) and confirm the lane is playing. */
async function launchAutomationClip(page: Page): Promise<void> {
  await page.getByTestId(`clipplayer-pad-${AUTO_IDX}`).click();
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { playing?: unknown[] } }> };
      };
      return w.__patch?.nodes?.['cp']?.data?.playing?.[7] === 0;
    },
    undefined,
    { timeout: 6000 },
  );
  // Gate on the transport: wait until the lane has actually stepped.
  await waitForSoundingStep(page, CP, 3, { key: 'currentStep:7', timeoutMs: 8000 });
}

/** Right-click a VCA's Base fader and open its control menu. */
function vcaBase(page: Page, vcaId: string) {
  return page.locator(`.svelte-flow__node[data-id="${vcaId}"]`).getByTestId('control-base');
}

async function assignViaMenu(page: Page, vcaId: string): Promise<void> {
  await vcaBase(page, vcaId).click({ button: 'right' });
  const menu = page.getByTestId('control-context-menu');
  await expect(menu).toBeVisible();
  // One automation clip in the rack → a direct "Assign to automation lane" item.
  await menu.getByTestId(`ctx-automation-${CP}`).click();
  await expect(menu).toBeHidden();
}

/** A left-button pointer grab of a VCA Base fader that stays HELD (pointer DOWN,
 *  not released) — fires the screen touch-suspend seam (notifyAutomationTouch on
 *  pointerdown) and holds the override until `releaseFader`. Per Phase 0 the
 *  override releases on the physical pointer-UP, NOT the loop wrap, so the caller
 *  must hold to observe the suspended state, then release to see it resume. */
async function grabFaderHold(page: Page, vcaId: string): Promise<void> {
  const fader = vcaBase(page, vcaId);
  await fader.scrollIntoViewIfNeeded();
  await fader.hover(); // moves to the track centre (scrolled into view)
  const box = await fader.boundingBox();
  if (!box) throw new Error(`grabFaderHold: no bounding box for ${vcaId}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // A real press-drag on the fader track: pointerdown fires the touch-suspend
  // seam (notifyAutomationTouch) and the drag moves the value (live wins). Leave
  // the pointer DOWN — the override holds until releaseFader.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - box.height * 0.35, { steps: 5 });
}
/** Release a held fader grab (pointer-UP) → the override ends, playback resumes. */
async function releaseFader(page: Page): Promise<void> {
  await page.mouse.up();
}

async function installSimMidi(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __midiTestInstall?: () => boolean }).__midiTestInstall === 'function',
  );
  await page.evaluate(() => (globalThis as unknown as { __midiTestInstall: () => boolean }).__midiTestInstall());
}
/** MIDI-learn a VCA Base fader to a CC (binds the CC → param; does NOT assign
 *  automation). The first inject completes the learn binding. */
async function midiLearn(page: Page, vcaId: string, cc: number): Promise<void> {
  await vcaBase(page, vcaId).click({ button: 'right' });
  const menu = page.getByTestId('control-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('ctx-midi-learn').click();
  await injectCc(page, 1, cc, 64); // bind
  await expect(menu).toBeHidden();
}

/** Sweep a bound CC (0..127) for `ms`. Each inject DRIVES the param AND fires
 *  notifyAutomationTouch — the exact seam a screen drag uses — so while armed it
 *  AUTO-CAPTURES the param + records it (record-while-touched). */
async function sweepCc(page: Page, cc: number, ms: number): Promise<void> {
  await sweepCcs(page, [cc], ms);
}
/** Sweep several bound CCs at once (each phase-offset so they diverge), touching +
 *  moving each one — for multi-param auto-capture/record. */
async function sweepCcs(page: Page, ccs: number[], ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = (Date.now() - start) / ms;
    for (let i = 0; i < ccs.length; i++) {
      const v = Math.round(64 + 58 * Math.sin(t * Math.PI * 2 * 2 + i * Math.PI));
      await injectCc(page, 1, ccs[i]!, Math.max(0, Math.min(127, v)));
    }
    await page.waitForTimeout(60);
  }
}

/** Keep a bound CC HOT at a CONSTANT value for `ms` (re-inject every ~50 ms) — the
 *  MIDI analogue of holding a fader down. The stream stays `active`, so the
 *  ~200 ms CC-idle release never fires and the automation override holds. Run it
 *  concurrently (don't await until done) while sampling the held param. */
async function holdCc(page: Page, channel: number, cc: number, value: number, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await injectCc(page, channel, cc, value);
    await page.waitForTimeout(50);
  }
}

async function injectCc(page: Page, channel: number, cc: number, value: number): Promise<void> {
  await page.evaluate(
    ({ channel, cc, value }) =>
      (globalThis as unknown as { __midiTestInject: (c: number, cc: number, v: number) => boolean }).__midiTestInject(
        channel,
        cc,
        value,
      ),
    { channel, cc, value },
  );
}

// A rising/falling envelope over CLIP_LEN steps that gives a clear playback spread.
const ENV_UP: SeedTrack['events'] = [
  { step: 0, value: 0.05 },
  { step: 4, value: 0.95 },
  { step: 7, value: 0.1 },
];
const ENV_DOWN: SeedTrack['events'] = [
  { step: 0, value: 0.95 },
  { step: 4, value: 0.05 },
  { step: 7, value: 0.9 },
];

// ── Case 1: the original brief ───────────────────────────────────────────────

test('automation: create + assign via menu + arm + record + playback drives the param', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.2 } },
  ]);
  await ensureTransportRunning(page);
  await installSimMidi(page);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();

  // CREATE the automation clip (+AUTO) — it comes up LONG + SLOW; shrink it to a
  // fast loop (8 steps ÷ '1' on the 1/16 grid ≈ 1s) so records commit quickly.
  await page.getByTestId(`clipplayer-auto-new-${CP}`).click();
  await expect(page.getByTestId(`clipplayer-auto-arm-${CP}`)).toBeVisible();
  await setAutoClip(page, CLIP_LEN, 3);

  // ASSIGN the VCA Base knob via the CONTEXT MENU (explicit-assign path), then bind
  // it to a CC so a "move" fires the real touch seam (record-while-touched).
  await assignViaMenu(page, 'va');
  await expect(page.getByTestId(`clipplayer-auto-count-${CP}`)).toHaveText(`1/16`);
  await midiLearn(page, 'va', 21);

  // LAUNCH + ARM, then MOVE the knob across ≥2 loops (touching it). Continuous
  // overdub punches in at the clip's own wrap and commits each wrap while armed.
  await launchAutomationClip(page);
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click(); // arm (claims recorderId)
  await sweepCc(page, 21, 3500);

  // A pass COMMITTED (breakpoints appear) while STILL ARMED (no auto-stop —
  // continuous overdub, the core of the new model).
  await expect
    .poll(async () => (await readClipTracks(page)).find((t) => t.nodeId === 'va')?.events.length ?? 0, {
      timeout: 12000,
    })
    .toBeGreaterThan(1);
  expect(await isArmed(page), 'continuous overdub — still armed after a commit').toBe(true);

  // DISARM (manual stop = press ARM again) right after a VARIED pass committed.
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click();
  expect(await isArmed(page), 'disarmed after the second ARM press').toBe(false);

  // PLAYBACK now drives the knob's param WITHOUT user input — assert it varies.
  const { spread } = await sampleSpread(page, 'va', 'base');
  expect(spread, 'automation playback varies the param over a loop').toBeGreaterThan(0.15);
});

// ── Case 1b: the 🟡🟡🔴🔴 countdown flashes in the last 4 beats ────────────────

test('automation: the countdown flashes yellow→red on the AUTO button in the last 4 beats before the clip wraps', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
  ]);
  await ensureTransportRunning(page);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();

  // A LONGER loop so the 4-beat countdown is a distinct window: 32 steps ÷ '1' on
  // the 1/16 grid ≈ 4s = 8 beats (countdown = the last ~2s).
  await page.getByTestId(`clipplayer-auto-new-${CP}`).click();
  await expect(page.getByTestId(`clipplayer-auto-arm-${CP}`)).toBeVisible();
  await setAutoClip(page, 32, 3);

  // LAUNCH + ARM — the countdown flashes while armed + looping (no moves needed).
  await launchAutomationClip(page);
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click(); // arm
  expect(await isArmed(page)).toBe(true);

  // Observe ≥2 loops (~9s over a 4s loop): the AUTO button flashes yellow (4,3
  // beats) THEN red (2,1 beats) before each wrap, published from the tick.
  const seq = await collectCountdown(page, 9500);
  expect(seq, 'countdown flashes yellow in the last 4 beats').toContain('yellow');
  expect(seq, 'countdown flashes red in the last 2 beats').toContain('red');
  expect(seq.indexOf('yellow'), 'yellow precedes red on the approach to the wrap').toBeLessThan(
    seq.lastIndexOf('red'),
  );

  // DISARM → the countdown clears (no stuck light).
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click();
  expect(await isArmed(page)).toBe(false);
  await expect.poll(async () => autoCountdownColor(page), { timeout: 4000 }).toBeNull();
});

// ── Case 2: multiple params over the armed window + move-detection ───────────

test('automation: two params record while armed + a third untouched keeps its prior automation', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 40 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 260 }, domain: 'audio', params: { base: 0.8 } },
    { id: 'vc', type: 'vca', position: { x: 460, y: 480 }, domain: 'audio', params: { base: 0.5 } },
  ]);
  await ensureTransportRunning(page);
  await installSimMidi(page);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();

  // Seed: va + vb EMPTY (to be recorded), vc PRE-POPULATED (the untouched one).
  const VC_PRIOR = [
    { step: 0, value: 0.2 },
    { step: 4, value: 0.8 },
  ];
  await seedAutomationClip(page, [
    { nodeId: 'va', paramId: 'base', events: [] },
    { nodeId: 'vb', paramId: 'base', events: [] },
    { nodeId: 'vc', paramId: 'base', events: VC_PRIOR },
  ]);
  // Bind va + vb to CCs so moving them fires the touch seam; vc is NEVER touched.
  await midiLearn(page, 'va', 21);
  await midiLearn(page, 'vb', 22);

  await launchAutomationClip(page);
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click(); // arm

  // Move BOTH va + vb (out of phase → independent), leave vc UNTOUCHED.
  await sweepCcs(page, [21, 22], 3400);

  await expect
    .poll(async () => {
      const t = await readClipTracks(page);
      const a = t.find((x) => x.nodeId === 'va')?.events.length ?? 0;
      const b = t.find((x) => x.nodeId === 'vb')?.events.length ?? 0;
      return Math.min(a, b);
    }, { timeout: 9000 })
    .toBeGreaterThan(1);
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click(); // disarm

  // Both moved params got breakpoints; the untouched vc kept its PRIOR automation.
  const tracks = await readClipTracks(page);
  expect(tracks.find((t) => t.nodeId === 'va')!.events.length).toBeGreaterThan(1);
  expect(tracks.find((t) => t.nodeId === 'vb')!.events.length).toBeGreaterThan(1);
  expect(tracks.find((t) => t.nodeId === 'vc')!.events, 'untouched track preserved').toEqual(VC_PRIOR);

  // Playback drives va + vb INDEPENDENTLY (both vary, and diverge from each other).
  const va = await sampleSpread(page, 'va', 'base');
  const vb = await sampleSpread(page, 'vb', 'base');
  expect(va.spread).toBeGreaterThan(0.15);
  expect(vb.spread).toBeGreaterThan(0.15);
  const diverge = await sampleDivergence(page, 'va', 'vb', 'base');
  expect(diverge, 'the two envelopes differ (recorded independently)').toBeGreaterThan(0.1);
  // vc is driven by its preserved automation too.
  const vc = await sampleSpread(page, 'vc', 'base');
  expect(vc.spread).toBeGreaterThan(0.1);
});

// ── Case 3: screen touch suspends only the grabbed param ─────────────────────

test('automation: grabbing an on-screen knob suspends only its playback until RELEASE (live wins); the other keeps playing; release resumes', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 60 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 300 }, domain: 'audio', params: { base: 0.8 } },
  ]);
  await ensureTransportRunning(page);
  await seedAutomationClip(page, [
    { nodeId: 'va', paramId: 'base', events: ENV_UP },
    { nodeId: 'vb', paramId: 'base', events: ENV_DOWN },
  ]);
  await launchAutomationClip(page);
  // The card resolves the seeded automation clip (2 tracks) — a precondition for
  // the override indicator (it intersects overridden keys with THIS clip's tracks).
  await expect(page.getByTestId(`clipplayer-auto-count-${CP}`)).toHaveText('2/16', { timeout: 4000 });

  // Both driven by playback.
  expect((await sampleSpread(page, 'va', 'base')).spread).toBeGreaterThan(0.15);
  expect((await sampleSpread(page, 'vb', 'base')).spread).toBeGreaterThan(0.15);

  // GRAB va's fader (screen) and HOLD it down → suspend ONLY va. Phase 0: the
  // override holds until the physical RELEASE, NOT the loop wrap, so a gesture
  // spanning a wrap is never yanked back mid-drag. The indicator lights.
  await grabFaderHold(page, 'va');
  await expect(page.getByTestId(`clipplayer-auto-override-${CP}`)).toBeVisible();
  await page.waitForTimeout(220); // let va settle to the grabbed value

  // WHILE STILL HELD (across at least one loop wrap): va stays held, vb still plays.
  const vaHeld = await sampleSpread(page, 'va', 'base');
  const vbLive = await sampleSpread(page, 'vb', 'base');
  expect(vaHeld.spread, 'grabbed param no longer follows the envelope (held across the wrap)').toBeLessThan(0.08);
  expect(vbLive.spread, 'the OTHER param keeps playing (per-param suspension)').toBeGreaterThan(0.15);

  // RELEASE (pointer-up) → the override ends, indicator clears, va resumes playback.
  await releaseFader(page);
  await expect(page.getByTestId(`clipplayer-auto-override-${CP}`)).toBeHidden();
  expect((await sampleSpread(page, 'va', 'base')).spread, 'va resumes after release').toBeGreaterThan(0.15);
});

// ── Param-jump policy (Phase 0): HOLD-LAST-VALUE on stop, no snap ─────────────

// An envelope that stays HIGH the whole loop (all values ≫ the VCA's 0.2 default
// and ≫ 0) — so the held value after a stop is unambiguously the last automated
// value, never a snap to default/zero.
const ENV_HELD_HIGH: SeedTrack['events'] = [
  { step: 0, value: 0.6 },
  { step: 4, value: 0.95 },
  { step: 7, value: 0.7 },
];

test('automation: on stop the param HOLDS its last automated value — no snap to default/zero', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.2 } },
  ]);
  await ensureTransportRunning(page);
  await seedAutomationClip(page, [{ nodeId: 'va', paramId: 'base', events: ENV_HELD_HIGH }]);
  await launchAutomationClip(page);
  await expect(page.getByTestId(`clipplayer-auto-count-${CP}`)).toHaveText('1/16', { timeout: 4000 });

  // Playback drives the param HIGH (well above the 0.2 default) and it varies.
  const playing = await sampleSpread(page, 'va', 'base');
  expect(playing.spread, 'automation playback varies the param').toBeGreaterThan(0.15);
  expect(Math.max(...playing.vals), 'driven to the high envelope').toBeGreaterThan(0.55);

  // STOP lane 7 (where the automation clip plays) → the clip stops driving its
  // params. Hold-last-value pins each at its deterministic last envelope value
  // (cancels the ghost tail). Setting playing[7]=null is the real lane-stop seam:
  // the tick adopts it (lane active → null) and the stop-detect holds the value.
  await page.evaluate((lane) => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { data?: { playing?: (number | null)[] } }> };
    };
    w.__ydoc.transact(() => {
      const d = w.__patch.nodes['cp'].data!;
      const playing = (Array.isArray(d.playing) ? d.playing.slice() : []) as (number | null)[];
      playing[lane] = null;
      d.playing = playing;
    });
  }, AUTO_LANE);
  await page.waitForTimeout(400); // let the stop tick adopt + fire hold-last-value

  // The param HOLDS a high value — NOT snapped to the 0.2 default, NOT to 0 — and
  // stays STABLE (no ghost-tail drift). This is the no-jump guarantee.
  const held = await sampleSpread(page, 'va', 'base', 8, 60);
  expect(Math.min(...held.vals), 'holds the last automated value, not the 0.2 default / 0')
    .toBeGreaterThan(0.5);
  expect(held.spread, 'held value is stable (no ghost-tail drift after stop)').toBeLessThan(0.1);
});

// ── Case 4: MIDI twist suspends only the twisted param (same seam) ───────────

test('automation: a MIDI CC on an automated param suspends only that param until the twist idles (same seam as screen); the other keeps playing; CC-idle resumes', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 60 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 300 }, domain: 'audio', params: { base: 0.8 } },
  ]);
  await ensureTransportRunning(page);
  await installSimMidi(page);
  await seedAutomationClip(page, [
    { nodeId: 'va', paramId: 'base', events: ENV_UP },
    { nodeId: 'vb', paramId: 'base', events: ENV_DOWN },
  ]);
  await launchAutomationClip(page);

  // Both driven by playback.
  expect((await sampleSpread(page, 'va', 'base')).spread).toBeGreaterThan(0.15);
  expect((await sampleSpread(page, 'vb', 'base')).spread).toBeGreaterThan(0.15);

  // MIDI-learn va's Base fader to CC 21, then HOLD it hot at a constant value: the
  // CC binds + drives + suspends automation for va through the SAME
  // notifyAutomationTouch seam. Phase 0: the override holds WHILE the twist is
  // active and releases on the CC-idle timeout (the MIDI analogue of pointer-up),
  // NOT the loop wrap — so we keep the stream hot to observe the held state.
  await vcaBase(page, 'va').click({ button: 'right' });
  const menu = page.getByTestId('control-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('ctx-midi-learn').click();
  await injectCc(page, 1, 21, 105); // binds + drives va toward ~0.83, suspends automation
  const hold = holdCc(page, 1, 21, 105, 1800); // keep it hot (concurrent) so the override holds
  await expect(page.getByTestId(`clipplayer-auto-override-${CP}`)).toBeVisible();
  await page.waitForTimeout(220);

  const vaHeld = await sampleSpread(page, 'va', 'base', 6, 70);
  const vbLive = await sampleSpread(page, 'vb', 'base', 6, 70);
  expect(vaHeld.spread, 'MIDI-twisted param no longer follows the envelope (held while hot)').toBeLessThan(0.08);
  expect(vaHeld.vals.at(-1) ?? 0, 'held near the CC value, not the envelope').toBeGreaterThan(0.6);
  expect(vbLive.spread, 'the OTHER param keeps playing (per-param suspension)').toBeGreaterThan(0.15);
  await hold; // stop the twist → the CC stream goes idle

  // CC-IDLE RELEASE → after the settle timeout the override ends automatically and
  // va resumes being driven by automation (no manual re-enable needed).
  await expect(page.getByTestId(`clipplayer-auto-override-${CP}`)).toBeHidden({ timeout: 4000 });
  expect((await sampleSpread(page, 'va', 'base')).spread, 'va resumes after the twist idles').toBeGreaterThan(0.15);
});

// ── Case 5: the owner's exact flow — JUST MOVE a knob while armed (auto-capture)
//    → it records + REPLAYS every loop (continuous, not one-shot) → move another. ──

test('automation: arm then JUST MOVE a knob → it auto-captures + records + replays every loop (not one-shot); then move B, A preserved', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 60 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 320 }, domain: 'audio', params: { base: 0.5 } },
  ]);
  await ensureTransportRunning(page);
  await installSimMidi(page);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();

  // ＋AUTO with NO pre-assign (count 0) + a ~3s loop (24 steps ÷ '1').
  await page.getByTestId(`clipplayer-auto-new-${CP}`).click();
  await expect(page.getByTestId(`clipplayer-auto-arm-${CP}`)).toBeVisible();
  await setAutoClip(page, 24, 3);
  await expect(page.getByTestId(`clipplayer-auto-count-${CP}`)).toHaveText('0/16'); // nothing assigned

  // Bind va/vb to CCs so a "move" is scriptable through the real touch seam.
  await midiLearn(page, 'va', 21);
  await midiLearn(page, 'vb', 22);

  // LAUNCH + ARM, then JUST MOVE va (no assign) for ~1.5 loops → auto-capture + record.
  await launchAutomationClip(page);
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click(); // arm
  await sweepCc(page, 21, 4500);

  // va became a track by MOVING it (auto-capture); arm STAYS LIT (not one-shot).
  await expect(page.getByTestId(`clipplayer-auto-count-${CP}`)).toHaveText('1/16', { timeout: 8000 });
  await expect
    .poll(async () => (await readClipTracks(page)).find((t) => t.nodeId === 'va')?.events.length ?? 0, { timeout: 12000 })
    .toBeGreaterThan(1);
  expect(await isArmed(page), 'arm stays lit — continuous overdub, not one-shot').toBe(true);

  // STOP moving va → over the next loops it REPLAYS (drives va.base with no input) —
  // the fix for "it recorded one pass then appeared to stop".
  const replay = await sampleSpread(page, 'va', 'base', 44, 100); // ~4.4s > 1 loop
  expect(replay.spread, 'va automation REPLAYS every loop while still armed').toBeGreaterThan(0.1);

  // The 🟡🟡🔴🔴 countdown flashes before each wrap while armed.
  const seq = await collectCountdown(page, 7000);
  expect(seq, 'countdown flashes yellow→red every loop').toContain('yellow');
  expect(seq).toContain('red');

  // Now MOVE vb on a later loop → vb overdubs; va is preserved.
  const vaBefore = (await readClipTracks(page)).find((t) => t.nodeId === 'va')!.events.length;
  await sweepCc(page, 22, 4500);
  await expect
    .poll(async () => (await readClipTracks(page)).find((t) => t.nodeId === 'vb')?.events.length ?? 0, { timeout: 12000 })
    .toBeGreaterThan(1);
  const tracks = await readClipTracks(page);
  expect(tracks.find((t) => t.nodeId === 'va')!.events.length, 'va preserved while vb overdubbed')
    .toBeGreaterThanOrEqual(Math.min(2, vaBefore));

  // DISARM (manual stop).
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click();
  expect(await isArmed(page)).toBe(false);
});
