// e2e/tests/push2-clip-launch.spec.ts
//
// PUSH 2 real-source-chain proof (the poly/MIDI discipline, CLAUDE.md): a pad
// press on a (simulated) Ableton Push 2 must LAUNCH a clip on the bound
// clip-player and drive a downstream VOICE to AUDIBLE output through the REAL
// TIMELORDE-locked clock — not just "a pad maps to a clip". The Push drives the
// SAME clip brain the Launchpad does, by injecting itself as the control surface
// (no forked parity logic), so this exercises the Push device + map + control
// adapter + the shipped launchpad-control end to end:
//
//   [sim Push pad (grid top-left = lane 0)] → clipplayer.queued[0]
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// Plus the additive features on the same rack: the Play button toggles the
// transport, an above-display button selects a LANE and the screen switches to
// that lane's PUSH CARD, a display encoder turns one of that card's controls,
// the master encoder drives MixMasters master volume, and the D-Pad scrolls the
// CLIP-view window.
//
// CI has no Push + no Web MIDI — everything routes through installSimulatedPush2,
// so this is capability-independent (no getUserMedia / WebUSB / hardware encoder).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

// Push 2 CC map — IMPORTED FROM THE SHIPPING MAP, never re-typed here.
//
// ⚠ This block used to hardcode seven literals, and on 2026-08-03 one of them
// went stale in exactly the way a duplicated constant always does: SHIFT moved
// off CC 49 (which became the ElectraControl mode toggle) onto CC 27, and this
// file kept pressing 49. The gesture silently degraded from a ×8 window to ×1 —
// the spec was pinning a contract that no longer existed, and no unit test could
// see it because the unit tests read the constant while this file read a copy.
//
// A literal in a spec is a SECOND SOURCE OF TRUTH for a binding, so a rename
// cannot redden it — it just quietly tests something else. Importing means a CC
// change either updates this spec automatically or fails to compile.
//
// `$lib` resolves for Playwright through packages/web/.svelte-kit/tsconfig.json
// (the same route freezeframe.spec.ts already relies on for a value import).
import {
  PUSH_CC_PLAY as CC_PLAY,
  PUSH_CC_SHIFT as CC_SHIFT,
  PUSH_CC_ELECTRA_MODE as CC_ELECTRA_MODE,
  PUSH_CC_DPAD_UP as CC_DPAD_UP,
  PUSH_CC_PERMANENT_BASE,
  PUSH_CC_ABOVE_DISPLAY_BASE as CC_ABOVE_DISPLAY_BASE,
  PUSH_CC_ENCODER_BASE as CC_ENCODER_BASE,
  PUSH_CC_ENCODER_MASTER as CC_ENCODER_MASTER,
} from '../../packages/web/src/lib/control/push2/push2-map';

test.describe.configure({ mode: 'parallel' });

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      for (const n of tls) {
        if (!n.params) n.params = {};
        n.params.running = run;
        n.params.bpm = 200;
      }
    });
  }, running);
}

async function timelordeRunning(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> } };
    const tl = Object.values(w.__patch.nodes).find((n) => n.type === 'timelorde');
    return tl?.params?.running ?? null;
  });
}

async function mixParam(page: import('@playwright/test').Page, paramId: string) {
  return page.evaluate((pid) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> } };
    const mx = Object.values(w.__patch.nodes).find((n) => n.type === 'mixmstrs');
    return mx?.params?.[pid] ?? null;
  }, paramId);
}

async function pushState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __push2Sim?: { state: () => Record<string, unknown> } };
    return w.__push2Sim?.state() ?? null;
  });
}

/** The PUSH CARD the 960×160 screen is showing (module, lane, focus, controls). */
async function pushCard(page: import('@playwright/test').Page) {
  const st = await pushState(page);
  return (st?.pushCard ?? null) as null | {
    lane: number | null;
    moduleType: string;
    title: string;
    empty: string | null;
    index: number | null;
    count: number | null;
    focus: string | null;
    controls: string[];
  };
}

async function nodeParam(page: import('@playwright/test').Page, nodeId: string, paramId: string) {
  return page.evaluate(([id, pid]) => {
    const w = globalThis as unknown as { __patch: { nodes: Record<string, { params?: Record<string, number> }> } };
    return w.__patch.nodes[id]?.params?.[pid] ?? null;
  }, [nodeId, paramId] as const);
}

// CLIP (note-editor) view: the permanent-controls row button 2 → the Launchpad
// top-row CLIP CC (93). Derived from the row base rather than written as 22, so
// it moves with the row. The dedicated "Note" button was a wrong guess.
const CC_CLIP_VIEW = PUSH_CC_PERMANENT_BASE + 2;

test('@push2 a simulated pad press launches a clip → audible RMS at the clipplayer voice', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'p-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: 'p-vco', type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: 'p-vca', type: 'vca', position: { x: 640, y: 60 }, domain: 'audio', params: { base: 0, cvAmount: 1 } },
      { id: 'p-scp', type: 'scope', position: { x: 920, y: 60 }, domain: 'audio', params: { timeMs: 200 } },
      { id: 'p-tl', type: 'timelorde', position: { x: 60, y: 320 }, domain: 'audio', params: { running: 0, bpm: 200 } },
    ],
    [
      { id: 'pe1', from: { nodeId: 'p-cp', portId: 'pitch1' }, to: { nodeId: 'p-vco', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: 'pe2', from: { nodeId: 'p-vco', portId: 'sine' }, to: { nodeId: 'p-vca', portId: 'audio' }, sourceType: 'audio', targetType: 'audio' },
      { id: 'pe3', from: { nodeId: 'p-cp', portId: 'gate1' }, to: { nodeId: 'p-vca', portId: 'cv' }, sourceType: 'gate', targetType: 'cv' },
      { id: 'pe4', from: { nodeId: 'p-vca', portId: 'audio' }, to: { nodeId: 'p-scp', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
    ],
  );

  await expect(page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')).toHaveCount(1);

  // Seed a clip in lane 0 / slot 0 (drives pitch1/gate1). Launched via the PUSH.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['p-cp'];
      if (!n.data) n.data = {};
      n.data.clips = {
        '0': {
          kind: 'note', lengthSteps: 4, root: 48, loop: true,
          steps: [
            { step: 0, midi: 72, velocity: 127, lengthSteps: 1 },
            { step: 1, midi: 74, velocity: 127, lengthSteps: 1 },
            { step: 2, midi: 76, velocity: 127, lengthSteps: 1 },
            { step: 3, midi: 79, velocity: 127, lengthSteps: 1 },
          ],
        },
      };
    });
  });

  // Install the SIMULATED Push + inject it as the control surface + bind. No Web
  // MIDI prompt; presses route through the real decode/classify/dispatch path.
  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
    if (!w.__push2TestInstall) return false;
    return await w.__push2TestInstall('p-cp');
  });
  expect(installed, 'simulated Push 2 install hook present (VITE_E2E_HOOKS)').toBe(true);

  // (1) Before the pad press the lane isn't playing → the VCA is closed → silent.
  await setTransport(page, 1);
  const before = await readScopePeakOverWindow(page, 'p-scp', 500);
  expect(before.rms, 'silent before the pad launches a clip').toBeLessThan(0.03);

  // (2) Press the grid top-left pad (x0, y7) → grid view maps it to lane 0.
  await page.evaluate(() => {
    const w = globalThis as unknown as { __push2Sim?: { press: (x: number, y: number) => void } };
    w.__push2Sim?.press(0, 7);
  });

  // The synced playing set must show lane 0 launched (pad → synced launch).
  await expect
    .poll(() => page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { type?: string; data?: { playing?: unknown[] } }> } };
      const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
      return cp?.data?.playing?.[0] ?? null;
    }), { timeout: 5000 })
    .toBe(0);

  // (3) The launched clip runs out lane-0's pitch/gate → AUDIBLE structured RMS.
  const after = await readScopePeakOverWindow(page, 'p-scp', 1500);
  expect(after.polls, 'SCOPE was polled across the window').toBeGreaterThan(0);
  expect(after.rms, 'audible gated RMS after the pad launch').toBeGreaterThan(0.03);
  expect(after.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(after.rms, 'the pad launch raised the output').toBeGreaterThan(before.rms + 0.02);
});

test('@push2 Play toggles transport; a LANE select shows that lane\u2019s PUSH CARD and its encoders drive it; D-Pad scrolls the clip window', async ({ page, rack, errorWatch }) => {
  await spawnPatch(
    page,
    [
      { id: 'q-cp', type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio', params: { quantize: 0, stepDiv: 2 } },
      // The workflow rack's PINNED mixer: it carries the per-lane member order
      // AND is the master encoder's target.
      { id: 'pinned-mixmstrs', type: 'mixmstrs', position: { x: 360, y: 60 }, domain: 'audio', params: { ch1_volume: 0.8, master_volume: 0.8 } },
      // A lane-1 member, so lane select has a real push card to show.
      { id: 'q-vca', type: 'vca', position: { x: 660, y: 60 }, domain: 'audio', params: { base: 0.5, cvAmount: 0 } },
      { id: 'q-tl', type: 'timelorde', position: { x: 60, y: 320 }, domain: 'audio', params: { running: 0, bpm: 120 } },
    ],
    [],
  );

  // Put the vca in channel column 1. `data.channel` is the MEMBERSHIP TRUTH the
  // reconciler (and the Push) read; the order array self-heals from it.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['q-vca'];
      if (!n.data) n.data = {};
      n.data.channel = 1;
    });
  });
  await expect(page.locator('.svelte-flow__node:has([data-shell-type="clipplayer"])')).toHaveCount(1);

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __push2TestInstall?: (id: string) => Promise<boolean> };
    if (!w.__push2TestInstall) return false;
    return await w.__push2TestInstall('q-cp');
  });
  expect(installed, 'simulated Push 2 install hook present').toBe(true);

  const cc = (n: number, v: number) =>
    page.evaluate(([num, val]) => {
      const w = globalThis as unknown as { __push2Sim?: { cc: (c: number, v: number) => void } };
      w.__push2Sim?.cc(num as number, val as number);
    }, [n, v] as const);

  // (A) Play button (CC 85) → START/STOP the transport (moved off the grid).
  expect(await timelordeRunning(page)).toBe(0);
  await cc(CC_PLAY, 127); await cc(CC_PLAY, 0);
  await expect.poll(() => timelordeRunning(page), { timeout: 3000 }).toBe(1);
  await cc(CC_PLAY, 127); await cc(CC_PLAY, 0);
  await expect.poll(() => timelordeRunning(page), { timeout: 3000 }).toBe(0);

  // (B) Above-display button 3 (CC 104) → select LANE 3 (Push-local). Lane 3 is
  // empty, so the screen says so rather than showing a stale card.
  await cc(CC_ABOVE_DISPLAY_BASE + 2, 127);
  await expect.poll(async () => (await pushState(page))?.selectedChannel, { timeout: 3000 }).toBe(2);
  await expect
    .poll(async () => (await pushCard(page))?.empty, { timeout: 3000 })
    .toBe('no-modules');

  // (B2) Above-display button 1 (CC 102) → LANE 1, whose only member is the vca:
  // the SELECTED CARD changes, and it is that module's card.
  await cc(CC_ABOVE_DISPLAY_BASE, 127);
  await expect.poll(async () => (await pushCard(page))?.focus, { timeout: 3000 }).toBe('q-vca');
  const card = await pushCard(page);
  expect(card?.moduleType, 'the screen shows the vca push card').toBe('vca');
  expect(card?.lane).toBe(1);
  expect(card?.empty).toBeNull();
  // The authored vca card is [base, cvAmount] — encoder 1 is `base`.
  expect(card?.controls?.slice(0, 2)).toEqual(['base', 'cvAmount']);

  // (C) Display encoder 1 (CC 71) +3 detents → the FOCUSED CARD's first control
  // (vca `base`), NOT a mixer channel. This is the owner's replacement for the
  // 8-knobs-as-a-mixer function.
  await cc(CC_ENCODER_BASE, 3);
  await expect.poll(() => nodeParam(page, 'q-vca', 'base'), { timeout: 3000 }).toBeGreaterThan(0.52);
  expect(await nodeParam(page, 'q-vca', 'base')).toBeLessThan(0.54);
  expect(await nodeParam(page, 'q-vca', 'cvAmount'), 'only strip 1 moved').toBe(0);
  expect(await mixParam(page, 'ch1_volume'), 'the mixer channel is NOT touched').toBe(0.8);

  // (C2) The MASTER encoder (CC 79) is the one mixer binding that survives.
  await cc(CC_ENCODER_MASTER, 3);
  await expect.poll(() => mixParam(page, 'master_volume'), { timeout: 3000 }).toBeGreaterThan(0.82);

  // (D) D-Pad → CLIP-view nav. Switch to CLIP view (permanent-row button 2 →
  // top CC 93), read the pitch-window offset, press D-Pad ↑ → +1; hold SHIFT
  // (the permanent-row button above channel 8, PUSH_CC_SHIFT = CC 27) + ↑ → +8.
  await cc(CC_CLIP_VIEW, 127); await cc(CC_CLIP_VIEW, 0);
  await expect.poll(async () => (await pushState(page))?.singleView, { timeout: 3000 }).toBe('clip');
  const base = Number((await pushState(page))?.editRowOffset ?? 0);
  await cc(CC_DPAD_UP, 127); await cc(CC_DPAD_UP, 0);
  await expect.poll(async () => (await pushState(page))?.editRowOffset, { timeout: 3000 }).toBe(base + 1);
  await cc(CC_SHIFT, 127); // hold SHIFT (CC 27)
  await cc(CC_DPAD_UP, 127); await cc(CC_DPAD_UP, 0);
  await cc(CC_SHIFT, 0); // release SHIFT
  await expect.poll(async () => (await pushState(page))?.editRowOffset, { timeout: 3000 }).toBe(base + 1 + 8);

  // (D2) NEGATIVE CONTROL, through the real device + brain: the button LABELLED
  // "Shift" (CC 49) is the ElectraControl mode toggle and is NOT a modifier, so
  // the SAME gesture on it must advance by ONE, not eight.
  //
  // This pins the direction the suite was missing. Before it, reverting SHIFT to
  // CC 49 would have made the (D) case above go green again while the new
  // ElectraControl binding silently died — i.e. the regression would have been
  // invisible to the very spec that just caught the move.
  const beforeElectra = Number((await pushState(page))?.editRowOffset ?? 0);
  await cc(CC_ELECTRA_MODE, 127); // "hold" the labelled Shift button
  await cc(CC_DPAD_UP, 127); await cc(CC_DPAD_UP, 0);
  await cc(CC_ELECTRA_MODE, 127); // press again to leave the mode it toggled
  await expect
    .poll(async () => (await pushState(page))?.editRowOffset, { timeout: 3000 })
    .toBe(beforeElectra + 1);
});
