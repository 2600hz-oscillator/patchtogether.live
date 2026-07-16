// e2e/tests/clip-automation.spec.ts
//
// PER-CLIP AUTOMATION — the real UI drive (redesign Phases 1+2). Proves the
// whole workflow end-to-end against the live app + engine, gating all timing on
// the clip transport (each lane's own playhead) so nothing races the wall clock.
//
// The observable for "playback drives the param" is engine.readParam(node,pid):
// the automation playback path writes each scheduled value into the engine's
// knobValues cache (engine.scheduleParam), and readParam reads that cache — so a
// param under automation VARIES over a loop, while a SUSPENDED (live-grabbed)
// param stays put. Store writes are separate (playback is zero-Yjs), so reading
// the store would show nothing; we read the ENGINE.
//
// Model (owner, redesign 2026-07-16): automation is PER-CLIP — every note clip
// owns a SIBLING `auto[k]` record (same stride-64 key as `clips[k]`). ASSIGN a
// control to a LANE (right-click → "Assign to automation lane ▸ 1–8"; one lane
// per control; the control name gets a thin border in the lane's colour), then
// the GLOBAL ◉ AUTO arm records: each lane with a PLAYING clip punches in at
// ITS clip's own next wrap and overdubs the ASSIGNED controls you MOVE into the
// PLAYING clip's own automation, every loop, until you disarm. Launching a clip
// launches its envelopes with it (length linked to the clip). There is NO
// auto-capture: moving an unassigned control records nothing.
//
// Cases:
//   1. Right-click assign to lane 1 (menu) → border colour cue + chip readout →
//      launch → ARM → twist across ≥2 loops → still armed (continuous) →
//      disarm → playback drives the param; the NOTE clip is byte-identical.
//   2. Clip-switch swaps automation WITH the clip (two clips in one lane, each
//      carrying its own envelope; no stuck values).
//   3. MULTI-LANE: two clips in two lanes each drive their own param.
//   4. SCREEN-touch suspends only the grabbed param until RELEASE ("live wins").
//   5. Hold-last-value on stop (param-jump policy, re-targeted at auto[k]).
//   6. MIDI-twist suspends via the SAME seam; CC-idle resumes.
//   7. The 🟡🟡🔴🔴 countdown flashes per recording lane while armed.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { waitForSoundingStep } from './_scheduler-control';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const CP = 'cp';
// Lane 0, slot 0 → flat stride-64 clip key 0; lane 0 slot 1 → 1; lane 1 slot 0 → 64.
const IDX_L0S0 = 0;
const IDX_L0S1 = 1;
const IDX_L1S0 = 64;
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

/** Seed a NOTE clip at flat index `idx` (+ optionally its SIBLING auto record +
 *  lane assignments) directly into the store — the deterministic path for the
 *  playback/suspension behaviour tests. */
async function seedClip(
  page: Page,
  idx: number,
  opts: { len?: number; tracks?: SeedTrack[]; assign?: Record<string, number> } = {},
): Promise<void> {
  await page.evaluate(
    ({ idx, len, tracks, assign }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      };
      w.__ydoc.transact(() => {
        const node = w.__patch.nodes['cp'];
        if (!node.data) node.data = {};
        const data = node.data as {
          clips?: Record<string, unknown>;
          auto?: Record<string, unknown>;
          autoAssign?: Record<string, number>;
        };
        if (!data.clips) data.clips = {};
        data.clips[String(idx)] = {
          kind: 'note',
          steps: [{ step: 0, midi: 60 }],
          lengthSteps: len,
          root: 48,
          loop: true,
        };
        if (tracks && tracks.length) {
          if (!data.auto) data.auto = {};
          const keyed: Record<string, unknown> = {};
          for (const t of tracks) keyed[`${t.nodeId}::${t.paramId}`] = { events: t.events };
          data.auto[String(idx)] = { tracks: keyed };
        }
        if (assign) {
          if (!data.autoAssign) data.autoAssign = {};
          for (const [k, lane] of Object.entries(assign)) data.autoAssign[k] = lane;
        }
      });
    },
    { idx, len: opts.len ?? CLIP_LEN, tracks: opts.tracks ?? [], assign: opts.assign },
  );
}

/** Read the sibling auto record's track events for (idx, nodeId::paramId). */
async function readAutoEvents(
  page: Page,
  idx: number,
  key: string,
): Promise<{ step: number; value: number }[]> {
  return page.evaluate(
    ({ idx, key }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<string, { data?: { auto?: Record<string, { tracks?: Record<string, { events?: Array<{ step?: number; value?: number }> }> }> } }>;
        };
      };
      const evs = w.__patch?.nodes?.['cp']?.data?.auto?.[String(idx)]?.tracks?.[key]?.events;
      if (!Array.isArray(evs)) return [];
      return evs.map((e) => ({ step: Number(e.step), value: Number(e.value) }));
    },
    { idx, key },
  );
}

/** JSON snapshot of the NOTE clip at `idx` (for the byte-identical assertion). */
async function noteClipSnapshot(page: Page, idx: number): Promise<string> {
  return page.evaluate(
    (idx) =>
      JSON.stringify(
        (globalThis as unknown as { __patch: { nodes: Record<string, { data?: { clips?: Record<string, unknown> } }> } })
          .__patch?.nodes?.['cp']?.data?.clips?.[String(idx)] ?? null,
      ),
    idx,
  );
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

/** The AUTO button's live countdown colour ('yellow' | 'red' | null) — the card
 *  mirror of the published per-lane render state (its cd-yellow / cd-red classes). */
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

/** Launch the clip at flat index `idx` in `lane` and gate on it SOUNDING. */
async function launchClip(page: Page, idx: number, lane: number, slot = 0): Promise<void> {
  await page.getByTestId(`clipplayer-pad-${idx}`).click();
  await page.waitForFunction(
    ({ lane, slot }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { playing?: unknown[] } }> };
      };
      return w.__patch?.nodes?.['cp']?.data?.playing?.[lane] === slot;
    },
    { lane, slot },
    { timeout: 6000 },
  );
  // Gate on the transport: wait until the lane has actually stepped.
  await waitForSoundingStep(page, CP, 3, { key: `currentStep:${lane}`, timeoutMs: 8000 });
}

/** Right-click a VCA's Base fader locator. */
function vcaBase(page: Page, vcaId: string) {
  return page.locator(`.svelte-flow__node[data-id="${vcaId}"]`).getByTestId('control-base');
}

/** Assign a VCA's Base to automation LANE `lane` via the real context menu:
 *  right-click → "Assign to automation lane ▸" → "Lane N". */
async function assignViaMenu(page: Page, vcaId: string, lane: number): Promise<void> {
  await vcaBase(page, vcaId).click({ button: 'right' });
  const menu = page.getByTestId('control-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId(`ctx-automation-${CP}`).hover(); // opens the lane flyout
  await menu.getByTestId(`ctx-automation-${CP}-lane-${lane}`).click();
  await expect(menu).toBeHidden();
}

/** The control-name BORDER colour cue: the fader label's computed border colour
 *  (or null when the auto-assigned class is absent). */
async function labelBorder(page: Page, vcaId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const card = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
    const ctrl = card?.querySelector('[data-testid="control-base"]');
    const wrap = ctrl?.closest('.fader-wrap') ?? ctrl?.closest('.knob-wrap');
    const label = wrap?.querySelector('.label');
    if (!label || !label.classList.contains('auto-assigned')) return null;
    return getComputedStyle(label as HTMLElement).borderTopColor;
  }, vcaId);
}

/** A left-button pointer grab of a VCA Base fader that stays HELD (pointer DOWN,
 *  not released) — fires the screen touch-suspend seam and holds the override
 *  until `releaseFader` (the override releases on physical pointer-UP, NOT the
 *  loop wrap). */
async function grabFaderHold(page: Page, vcaId: string): Promise<void> {
  const fader = vcaBase(page, vcaId);
  await fader.scrollIntoViewIfNeeded();
  await fader.hover();
  const box = await fader.boundingBox();
  if (!box) throw new Error(`grabFaderHold: no bounding box for ${vcaId}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
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
 *  notifyAutomationTouch — the exact seam a screen drag uses — so while armed an
 *  ASSIGNED param records (record-while-touched). */
async function sweepCc(page: Page, cc: number, ms: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const t = (Date.now() - start) / ms;
    const v = Math.round(64 + 58 * Math.sin(t * Math.PI * 2 * 2));
    await injectCc(page, 1, cc, Math.max(0, Math.min(127, v)));
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

// Envelopes over CLIP_LEN steps that give a clear playback spread / range split.
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
// A's envelope stays HIGH (0.6..0.95); B's stays LOW (0.05..0.3) — so which
// clip's automation owns the param is legible from the value range.
const ENV_HIGH: SeedTrack['events'] = [
  { step: 0, value: 0.7 },
  { step: 4, value: 0.95 },
  { step: 7, value: 0.6 },
];
const ENV_LOW: SeedTrack['events'] = [
  { step: 0, value: 0.2 },
  { step: 4, value: 0.05 },
  { step: 7, value: 0.3 },
];

// ── Case 1: the full owner workflow — assign (menu) → arm → twist → playback ──

test('per-clip automation: right-click assign to a lane → arm → record while twisting → disarm → playback; note clip untouched', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.2 } },
  ]);
  await ensureTransportRunning(page);
  await installSimMidi(page);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();

  // A note clip in lane 0, slot 0 (its sibling automation starts empty).
  await seedClip(page, IDX_L0S0, { len: CLIP_LEN });
  const noteBefore = await noteClipSnapshot(page, IDX_L0S0);

  // ASSIGN va.base → lane 1 via the REAL context menu (lane index 0 = "Lane 1").
  await assignViaMenu(page, 'va', 0);
  // UI-CAN'T-LIE (assignment cue): the control NAME gets a thin border in the
  // lane's colour, and the AUTO block's lane-0 chip reads 1.
  await expect.poll(async () => labelBorder(page, 'va'), { timeout: 4000 }).not.toBeNull();
  const border = await labelBorder(page, 'va');
  // Lane 0's default channel colour is hsl(0,70%,50%) = #d92626 = rgb(217,38,38).
  expect(border).toBe('rgb(217, 38, 38)');
  await expect(page.getByTestId('clipplayer-auto-assigned-0')).toHaveText('1');
  await expect(page.getByTestId('clipplayer-auto-assigned-0')).toHaveAttribute('data-count', '1');

  // Bind the fader to a CC so a scripted "move" fires the real touch seam.
  await midiLearn(page, 'va', 21);

  // LAUNCH the clip + ARM (global CLIP RECORD), then MOVE the assigned control
  // across ≥2 loops — the lane punches in at ITS clip's own wrap and overdubs.
  await launchClip(page, IDX_L0S0, 0);
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click(); // arm (claims recorderId)
  // UI-CAN'T-LIE (arm light): the button state mirrors data.automation.arm.
  await expect(page.getByTestId(`clipplayer-auto-arm-${CP}`)).toHaveAttribute('aria-pressed', 'true');
  expect(await isArmed(page)).toBe(true);
  await sweepCc(page, 21, 3500);

  // A pass COMMITTED into the PLAYING clip's sibling auto record (per-key)
  // while STILL ARMED (continuous overdub — no auto-stop).
  await expect
    .poll(async () => (await readAutoEvents(page, IDX_L0S0, 'va::base')).length, { timeout: 12000 })
    .toBeGreaterThan(1);
  expect(await isArmed(page), 'continuous overdub — still armed after a commit').toBe(true);

  // THE HEADLINE INVARIANT: the NOTE clip at clips[k] is BYTE-IDENTICAL — the
  // recording session never touched the note key (disjoint CRDT scopes).
  expect(await noteClipSnapshot(page, IDX_L0S0), 'note clip untouched by recording').toBe(noteBefore);

  // DISARM (manual stop = press ARM again).
  await page.getByTestId(`clipplayer-auto-arm-${CP}`).click();
  expect(await isArmed(page), 'disarmed after the second ARM press').toBe(false);
  await expect(page.getByTestId(`clipplayer-auto-arm-${CP}`)).toHaveAttribute('aria-pressed', 'false');

  // PLAYBACK now drives the param WITHOUT user input — assert it varies.
  const { spread } = await sampleSpread(page, 'va', 'base');
  expect(spread, 'automation playback varies the param over a loop').toBeGreaterThan(0.15);

  // CARRIER DOT: the recorded clip's pad marks that it carries automation.
  await expect(page.getByTestId(`clipplayer-pad-${IDX_L0S0}`)).toHaveAttribute('data-auto', '1');

  // REMOVE the assignment → the border cue clears (the chip drops to 0); the
  // recorded automation keeps playing (assignment gates RECORD, not playback).
  await vcaBase(page, 'va').click({ button: 'right' });
  const menu = page.getByTestId('control-context-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId('ctx-automation-remove').click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => labelBorder(page, 'va'), { timeout: 4000 }).toBeNull();
  await expect(page.getByTestId('clipplayer-auto-assigned-0')).toHaveAttribute('data-count', '0');
  // The recorded envelopes SURVIVE the un-assignment (remove ≠ clear).
  expect((await readAutoEvents(page, IDX_L0S0, 'va::base')).length).toBeGreaterThan(1);

  // CLEAR RECORDED AUTOMATION (the delete affordance): right-click → clear →
  // the envelopes are gone and the carrier dot clears.
  await vcaBase(page, 'va').click({ button: 'right' });
  await expect(menu).toBeVisible();
  await menu.getByTestId('ctx-automation-clear').click();
  await expect(menu).toBeHidden();
  await expect
    .poll(async () => (await readAutoEvents(page, IDX_L0S0, 'va::base')).length, { timeout: 4000 })
    .toBe(0);
  await expect(page.getByTestId(`clipplayer-pad-${IDX_L0S0}`)).not.toHaveAttribute('data-auto', '1');
});

// ── Case 2: clip-switch swaps automation WITH the clip ───────────────────────

test('per-clip automation: switching clips in a lane swaps to the NEW clip’s own envelope (each clip carries its own)', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.5 } },
  ]);
  await ensureTransportRunning(page);
  // TWO clips in lane 0: slot 0 carries a HIGH envelope, slot 1 a LOW one.
  await seedClip(page, IDX_L0S0, { tracks: [{ nodeId: 'va', paramId: 'base', events: ENV_HIGH }] });
  await seedClip(page, IDX_L0S1, { tracks: [{ nodeId: 'va', paramId: 'base', events: ENV_LOW }] });

  // Launch clip A → its envelope drives va HIGH.
  await launchClip(page, IDX_L0S0, 0, 0);
  await expect
    .poll(async () => (await sampleSpread(page, 'va', 'base', 8, 60)).vals.every((v) => v > 0.5), {
      timeout: 8000,
    })
    .toBe(true);

  // Launch clip B (same lane) → the automation SWAPS with the clip: va now
  // rides B's LOW envelope (values < 0.35), never stuck at A's high values.
  await page.getByTestId(`clipplayer-pad-${IDX_L0S1}`).click();
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { playing?: unknown[] } }> };
      };
      return w.__patch?.nodes?.['cp']?.data?.playing?.[0] === 1;
    },
    undefined,
    { timeout: 10000 },
  );
  await page.waitForTimeout(500); // past the switch seam (glide is ~12ms)
  const after = await sampleSpread(page, 'va', 'base', 10, 70);
  expect(Math.max(...after.vals), 'B’s LOW envelope owns the param after the switch').toBeLessThan(0.45);
});

// ── Case 3: MULTI-LANE — two clips in two lanes, each with its own automation ─

test('per-clip automation: two lanes drive two params independently from their own clips', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 60 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 300 }, domain: 'audio', params: { base: 0.8 } },
  ]);
  await ensureTransportRunning(page);
  await seedClip(page, IDX_L0S0, { tracks: [{ nodeId: 'va', paramId: 'base', events: ENV_UP }] });
  await seedClip(page, IDX_L1S0, { tracks: [{ nodeId: 'vb', paramId: 'base', events: ENV_DOWN }] });
  await launchClip(page, IDX_L0S0, 0);
  await launchClip(page, IDX_L1S0, 1);

  // Both params ride their OWN lane's clip envelope, independently.
  const va = await sampleSpread(page, 'va', 'base');
  const vb = await sampleSpread(page, 'vb', 'base');
  expect(va.spread, 'lane 0’s clip drives va').toBeGreaterThan(0.15);
  expect(vb.spread, 'lane 1’s clip drives vb').toBeGreaterThan(0.15);
  const diverge = await sampleDivergence(page, 'va', 'vb', 'base');
  expect(diverge, 'the two envelopes differ (independent lanes)').toBeGreaterThan(0.1);
});

// ── Case 4: screen touch suspends only the grabbed param ─────────────────────

test('per-clip automation: grabbing an on-screen fader suspends only its playback until RELEASE; the other keeps playing', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 60 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 300 }, domain: 'audio', params: { base: 0.8 } },
  ]);
  await ensureTransportRunning(page);
  await seedClip(page, IDX_L0S0, {
    tracks: [
      { nodeId: 'va', paramId: 'base', events: ENV_UP },
      { nodeId: 'vb', paramId: 'base', events: ENV_DOWN },
    ],
  });
  await launchClip(page, IDX_L0S0, 0);

  // Both driven by playback.
  expect((await sampleSpread(page, 'va', 'base')).spread).toBeGreaterThan(0.15);
  expect((await sampleSpread(page, 'vb', 'base')).spread).toBeGreaterThan(0.15);

  // GRAB va's fader (screen) and HOLD it down → suspend ONLY va. The override
  // holds until the physical RELEASE, NOT the loop wrap. The indicator lights.
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

// ── Case 5: param-jump policy — HOLD-LAST-VALUE on stop, no snap ──────────────

// An envelope that stays HIGH the whole loop (all values ≫ the VCA's 0.2 default
// and ≫ 0) — so the held value after a stop is unambiguously the last automated
// value, never a snap to default/zero.
const ENV_HELD_HIGH: SeedTrack['events'] = [
  { step: 0, value: 0.6 },
  { step: 4, value: 0.95 },
  { step: 7, value: 0.7 },
];

test('per-clip automation: on stop the param HOLDS its last automated value — no snap to default/zero', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.2 } },
  ]);
  await ensureTransportRunning(page);
  await seedClip(page, IDX_L0S0, {
    tracks: [{ nodeId: 'va', paramId: 'base', events: ENV_HELD_HIGH }],
  });
  await launchClip(page, IDX_L0S0, 0);

  // Playback drives the param HIGH (well above the 0.2 default) and it varies.
  const playing = await sampleSpread(page, 'va', 'base');
  expect(playing.spread, 'automation playback varies the param').toBeGreaterThan(0.15);
  expect(Math.max(...playing.vals), 'driven to the high envelope').toBeGreaterThan(0.55);

  // STOP lane 0 → the clip stops driving its params. Hold-last-value pins each
  // at its deterministic last envelope value (cancels the ghost tail). Setting
  // playing[0]=null is the real lane-stop seam: the tick adopts it and the
  // stop-detect holds the value.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __ydoc: { transact: (fn: () => void) => void };
      __patch: { nodes: Record<string, { data?: { playing?: (number | null)[] } }> };
    };
    w.__ydoc.transact(() => {
      const d = w.__patch.nodes['cp'].data!;
      const playing = (Array.isArray(d.playing) ? d.playing.slice() : []) as (number | null)[];
      playing[0] = null;
      d.playing = playing;
    });
  });
  await page.waitForTimeout(400); // let the stop tick adopt + fire hold-last-value

  // The param HOLDS a high value — NOT snapped to the 0.2 default, NOT to 0 — and
  // stays STABLE (no ghost-tail drift). This is the no-jump guarantee.
  const held = await sampleSpread(page, 'va', 'base', 8, 60);
  expect(Math.min(...held.vals), 'holds the last automated value, not the 0.2 default / 0')
    .toBeGreaterThan(0.5);
  expect(held.spread, 'held value is stable (no ghost-tail drift after stop)').toBeLessThan(0.1);
});

// ── Case 6: MIDI twist suspends only the twisted param (same seam) ───────────

test('per-clip automation: a MIDI CC on an automated param suspends only that param until the twist idles; CC-idle resumes', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 60 }, domain: 'audio', params: { base: 0.2 } },
    { id: 'vb', type: 'vca', position: { x: 460, y: 300 }, domain: 'audio', params: { base: 0.8 } },
  ]);
  await ensureTransportRunning(page);
  await installSimMidi(page);
  await seedClip(page, IDX_L0S0, {
    tracks: [
      { nodeId: 'va', paramId: 'base', events: ENV_UP },
      { nodeId: 'vb', paramId: 'base', events: ENV_DOWN },
    ],
  });
  await launchClip(page, IDX_L0S0, 0);

  // Both driven by playback.
  expect((await sampleSpread(page, 'va', 'base')).spread).toBeGreaterThan(0.15);
  expect((await sampleSpread(page, 'vb', 'base')).spread).toBeGreaterThan(0.15);

  // MIDI-learn va's Base fader to CC 21, then HOLD it hot at a constant value: the
  // CC binds + drives + suspends automation for va through the SAME
  // notifyAutomationTouch seam. The override holds WHILE the twist is active and
  // releases on the CC-idle timeout (the MIDI analogue of pointer-up), NOT the
  // loop wrap — so we keep the stream hot to observe the held state.
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

// ── Case 8: SCENE DUPLICATE carries the automation with the clips ────────────
// The perform gesture the lifecycle fix exists for: copying a scene to another
// slot must carry each clip's envelopes (the envelope belongs to the clip).
// Driven through the REAL single-unit Launchpad sim (shift palette → COPY a
// scene → PASTE it at another slot).

const CC_SHIFT = 98; // the single-unit shift (tap = latch) top-row CC
const CC_VIEW_GRID = 92; // the permanent top-row GRID view button
const SCENE_CC = [89, 79, 69, 59, 49, 39, 29, 19] as const; // scene idx 0..7
const CC_G_COPY = SCENE_CC[0]; // grid-shift palette: COPY = scene index 0
const CC_G_PASTE = SCENE_CC[1]; // PASTE = scene index 1

test('per-clip automation: scene-duplicate (Launchpad copy/paste) carries the automation with the clips', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.2 } },
  ]);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();
  // Scene 0: a clip in lane 0 carrying an envelope.
  await seedClip(page, IDX_L0S0, { tracks: [{ nodeId: 'va', paramId: 'base', events: ENV_UP }] });

  // Install the simulated single-unit Launchpad bound to this player.
  const installed = await page.evaluate(async (id) => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    if (!w.__launchpadTestInstallSingle) return false;
    return await w.__launchpadTestInstallSingle(id);
  }, CP);
  expect(installed, 'single-unit Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);
  const ccTap = async (cc: number) => {
    await page.evaluate((c) => {
      const s = (globalThis as unknown as { __launchpadSingleSim?: { cc: (cc: number, v: number) => void } })
        .__launchpadSingleSim!;
      s.cc(c, 127);
      s.cc(c, 0);
    }, cc);
  };

  // The install hook boots in CLIP view — flip to GRID (the copy/paste home).
  await ccTap(CC_VIEW_GRID);
  await page.waitForFunction(() =>
    (globalThis as unknown as { __launchpadSingleSim?: { state: () => { singleView?: string } } })
      .__launchpadSingleSim?.state().singleView === 'grid',
  );

  // COPY scene 0: latch shift → arm COPY → unlatch (sticky) → tap scene 0.
  await ccTap(CC_SHIFT);
  await ccTap(CC_G_COPY);
  await ccTap(CC_SHIFT);
  await ccTap(SCENE_CC[0]);
  // PASTE at scene 3: latch shift → arm PASTE → unlatch → tap scene 3.
  await ccTap(CC_SHIFT);
  await ccTap(CC_G_PASTE);
  await ccTap(CC_SHIFT);
  await ccTap(SCENE_CC[3]);

  // The clip landed at slot 3 (lane 0 → flat index 3) WITH its automation.
  const IDX_L0S3 = 3;
  await expect
    .poll(async () => (await readAutoEvents(page, IDX_L0S3, 'va::base')).length, { timeout: 6000 })
    .toBeGreaterThan(1);
  expect(await readAutoEvents(page, IDX_L0S3, 'va::base')).toEqual(
    await readAutoEvents(page, IDX_L0S0, 'va::base'), // copied, source intact
  );
  // Both pads mark as carriers.
  await expect(page.getByTestId(`clipplayer-pad-${IDX_L0S0}`)).toHaveAttribute('data-auto', '1');
  await expect(page.getByTestId(`clipplayer-pad-${IDX_L0S3}`)).toHaveAttribute('data-auto', '1');
  // Launching the DUPLICATE drives the param from ITS own envelope.
  await ensureTransportRunning(page);
  await launchClip(page, IDX_L0S3, 0, 3);
  const { spread } = await sampleSpread(page, 'va', 'base');
  expect(spread, 'the duplicated clip’s automation plays').toBeGreaterThan(0.15);
});

// ── Case 7: the 🟡🟡🔴🔴 countdown flashes per recording lane while armed ─────

test('per-clip automation: the countdown flashes yellow→red on the AUTO button while a lane records; disarm clears it', async ({ page, rack }) => {
  void rack;
  await spawnPatch(page, [
    { id: CP, type: 'clipplayer', position: { x: 80, y: 80 }, domain: 'audio' },
    { id: 'va', type: 'vca', position: { x: 460, y: 80 }, domain: 'audio', params: { base: 0.2 } },
  ]);
  await ensureTransportRunning(page);
  await expect(page.getByTestId('clipplayer-card')).toBeVisible();

  // A LONGER clip so the 4-beat countdown is a distinct window: 32 steps on the
  // 1/16 grid ≈ 4s = 8 beats (countdown = the last ~2s). Assign a param to lane
  // 0 (the countdown publishes only for lanes with assigned params).
  await seedClip(page, IDX_L0S0, { len: 32, assign: { 'va::base': 0 } });

  // LAUNCH + ARM — the countdown flashes while armed + looping (no moves needed).
  await launchClip(page, IDX_L0S0, 0);
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
