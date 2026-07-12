// e2e/tests/launchpad-keys-record.spec.ts
//
// LAUNCHPAD **KEYS** real-source-chain proof (the poly/MIDI discipline,
// CLAUDE.md): the dual-Launchpad note/keyboard + clip-record view must (1) play
// the keys LIVE to a real voice — AUDIBLE — and (2) RECORD what you play into
// the clip so it SOUNDS back on the next loop. Both go through the SAME
// decode/dispatch path real hardware uses (installSimulatedLaunchpad → the
// launchpad-control KEYS binding → the clip-audition side-channel drained by the
// clipplayer factory) into the real TIMELORDE-locked chain:
//
//   [sim Launchpad KEYS keyboard pad] → clip-audition → clipplayer.pitch1/gate1
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// The clip is EMPTY so any sound is the KEYS keyboard, not a pre-seeded pattern —
// which is exactly the green-but-silent class this guards.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// KEYS placement (mirrors launchpad-map): the note-REC hold is deck (col 0, row
// 1), note-OVERDUB (col 1, row 1); QUEUE-REC + EXIT live on unit L's bottom row.
const DECK_KEYS_REC = { x: 0, y: 1 };
const DECK_KEYS_OVERDUB = { x: 1, y: 1 };
const KEYS_QREC = { x: 1, y: 0 };
const KEYS_EXIT = { x: 0, y: 0 };
// The clip pad for lane 0 / slot 0 is the card top-left → physical y=7 (the L
// matrix flips lane→row so lane 0 is the TOP row).
const CLIP_L0S0 = { x: 0, y: 7 };
// A keyboard pad in the note band (y=1..6). (0,1) = keyboard col 0 row 0 = root.
const KEY_ROOT = { x: 0, y: 1 };
const KEY_A = { x: 2, y: 2 };
const KEY_B = { x: 4, y: 3 };

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-keys'] = {
          id: 'tl-keys', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
          params: { running: run, bpm: 220 }, data: {},
        } as never;
      } else {
        for (const n of tls) {
          if (!n.params) n.params = {};
          n.params.running = run;
          n.params.bpm = 220;
        }
      }
    });
  }, running);
}

/** Seed a clip-player node with an EMPTY (short-loop) clip at lane 0 / slot 0. */
async function seedEmptyClip(page: import('@playwright/test').Page, nodeId: string) {
  await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes[id];
      if (!n.data) n.data = {};
      n.data.clips = { '0': { kind: 'note', steps: [], lengthSteps: 4, root: 48, scale: 'major', loop: true } };
    });
  }, nodeId);
}

/** The KEYS binding state (mode / keys clip / overdub) via the sim probe. */
async function keysState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __launchpadSim?: { state: () => { mode: string; keysClipIndex: number } } };
    return w.__launchpadSim?.state() ?? null;
  });
}
/** node.data.noteRec.recording for the clip-player. */
async function isRecording(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { noteRec?: { recording?: boolean } | null } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.noteRec?.recording === true;
  });
}
/** Number of note events in the clip-player's clip 0. */
async function clipSteps(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { clips?: Record<string, { steps?: unknown[] }> } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return Array.isArray(cp?.data?.clips?.['0']?.steps) ? cp!.data!.clips!['0'].steps!.length : 0;
  });
}

async function pressL(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    (globalThis as unknown as { __launchpadSim?: { pressL: (x: number, y: number) => void } }).__launchpadSim?.pressL(x, y);
  }, { x, y });
}
async function releaseL(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    (globalThis as unknown as { __launchpadSim?: { releaseL: (x: number, y: number) => void } }).__launchpadSim?.releaseL(x, y);
  }, { x, y });
}
async function pressR(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    (globalThis as unknown as { __launchpadSim?: { pressR: (x: number, y: number) => void } }).__launchpadSim?.pressR(x, y);
  }, { x, y });
}
async function releaseR(page: import('@playwright/test').Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    (globalThis as unknown as { __launchpadSim?: { releaseR: (x: number, y: number) => void } }).__launchpadSim?.releaseR(x, y);
  }, { x, y });
}

/** Enter KEYS: hold the entry modifier + double-tap the clip on L, then release. */
async function enterKeys(page: import('@playwright/test').Page, hold: { x: number; y: number }) {
  await pressR(page, hold.x, hold.y); // hold note-REC / note-OVERDUB
  await pressL(page, CLIP_L0S0.x, CLIP_L0S0.y); // 1st tap (suppressed)
  await pressL(page, CLIP_L0S0.x, CLIP_L0S0.y); // 2nd tap → enter KEYS
  await releaseL(page, CLIP_L0S0.x, CLIP_L0S0.y);
  await releaseR(page, hold.x, hold.y);
}

async function buildChain(page: import('@playwright/test').Page, prefix: string) {
  await spawnPatch(
    page,
    [
      { id: `${prefix}-cp`, type: 'clipplayer', position: { x: 60, y: 60 }, domain: 'audio',
        params: { quantize: 0, stepDiv: 2, gateLength: 0.9, octave: 0 } },
      { id: `${prefix}-vco`, type: 'analogVco', position: { x: 360, y: 60 }, domain: 'audio' },
      { id: `${prefix}-vca`, type: 'vca', position: { x: 640, y: 60 }, domain: 'audio',
        params: { base: 0, cvAmount: 1 } },
      { id: `${prefix}-scp`, type: 'scope', position: { x: 920, y: 60 }, domain: 'audio',
        params: { timeMs: 200 } },
    ],
    [
      { id: `${prefix}1`, from: { nodeId: `${prefix}-cp`, portId: 'pitch1' }, to: { nodeId: `${prefix}-vco`, portId: 'pitch' },
        sourceType: 'polyPitchGate', targetType: 'pitch' },
      { id: `${prefix}2`, from: { nodeId: `${prefix}-vco`, portId: 'sine' }, to: { nodeId: `${prefix}-vca`, portId: 'audio' },
        sourceType: 'audio', targetType: 'audio' },
      { id: `${prefix}3`, from: { nodeId: `${prefix}-cp`, portId: 'gate1' }, to: { nodeId: `${prefix}-vca`, portId: 'cv' },
        sourceType: 'gate', targetType: 'cv' },
      { id: `${prefix}4`, from: { nodeId: `${prefix}-vca`, portId: 'audio' }, to: { nodeId: `${prefix}-scp`, portId: 'ch1' },
        sourceType: 'audio', targetType: 'audio' },
    ],
  );
  await expect(page.locator('.svelte-flow__node-clipplayer')).toHaveCount(1);
}

test('@launchpad KEYS live audition — playing a keyboard pad is AUDIBLE (empty clip, transport running)', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'k');
  await seedEmptyClip(page, 'k-cp');

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstall?: (id: string) => Promise<boolean> };
    return w.__launchpadTestInstall ? await w.__launchpadTestInstall('k-cp') : false;
  });
  expect(installed, 'simulated Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);

  await setTransport(page, 1);
  await enterKeys(page, DECK_KEYS_REC);
  await expect.poll(() => keysState(page).then((s) => s?.mode), { timeout: 15_000 }).toBe('keys');

  // (1) The clip is EMPTY → even playing, the voice is silent until a key sounds.
  const before = await readScopePeakOverWindow(page, 'k-scp', 500);
  expect(before.rms, 'silent before a KEYS key is played (empty clip)').toBeLessThan(0.03);

  // (2) Hold a keyboard pad → live audition → AUDIBLE structured RMS.
  await pressL(page, KEY_ROOT.x, KEY_ROOT.y);
  const during = await readScopePeakOverWindow(page, 'k-scp', 1200);
  expect(during.polls, 'SCOPE polled across the window').toBeGreaterThan(0);
  expect(during.rms, 'audible RMS while a KEYS key is held (live audition)').toBeGreaterThan(0.03);
  expect(during.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(during.rms, 'the keypress raised the output').toBeGreaterThan(before.rms + 0.02);

  // (3) Release → the audition gate closes → falls silent.
  await releaseL(page, KEY_ROOT.x, KEY_ROOT.y);
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 'k-scp', 400)).rms, { timeout: 15_000 })
    .toBeLessThan(0.03);

});

// SINGLE-UNIT KEYS — the same real-source-chain proof on ONE device. Entry uses
// the single gesture family: hold note-REC on the deck (CONTROL view), CC-98
// flip to CLIP (the hold survives), DOUBLE-TAP the clip → KEYS owns the lone
// device (8-wide keyboard, 8-cell whole-clip playhead, CC 98 inactive). Then:
// live audition is AUDIBLE, queue-record captures played notes, and EXIT stops
// the take — all through the REAL TIMELORDE→clipplayer→VCO→VCA→SCOPE chain.
test('@launchpad single-unit KEYS — enter on one device, live keys are AUDIBLE, queue-record captures notes', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 's');
  await seedEmptyClip(page, 's-cp');

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    return w.__launchpadTestInstallSingle ? await w.__launchpadTestInstallSingle('s-cp') : false;
  });
  expect(installed, 'single simulated Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);

  const pressS = (x: number, y: number) =>
    page.evaluate(({ x, y }) => {
      (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } })
        .__launchpadSingleSim!.press(x, y);
    }, { x, y });
  const releaseS = (x: number, y: number) =>
    page.evaluate(({ x, y }) => {
      (globalThis as unknown as { __launchpadSingleSim?: { release: (x: number, y: number) => void } })
        .__launchpadSingleSim!.release(x, y);
    }, { x, y });
  const viewFlipS = () =>
    page.evaluate(() => {
      (globalThis as unknown as { __launchpadSingleSim?: { viewFlip: () => void } }).__launchpadSingleSim!.viewFlip();
    });
  const singleState = () =>
    page.evaluate(() => {
      const w = globalThis as unknown as { __launchpadSingleSim?: { state: () => { activeView: string; mode: string } } };
      return w.__launchpadSingleSim!.state();
    });

  await setTransport(page, 1);

  // ENTER KEYS on the one device: CONTROL view → hold note-OVERDUB (deck row 1;
  // additive, so recorded notes accumulate deterministically — same reason the
  // pair record test enters via OVERDUB) → CC-98 back to CLIP (the hold
  // survives) → double-tap the clip → release.
  await viewFlipS(); // clip → control
  await pressS(DECK_KEYS_OVERDUB.x, DECK_KEYS_OVERDUB.y); // hold note-OVERDUB
  await viewFlipS(); // control → clip (the hold survives the flip)
  // Double-tap back-to-back inside ONE evaluate (~0-tick gap, deterministic).
  await page.evaluate(({ x, y }) => {
    const s = (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } })
      .__launchpadSingleSim!;
    s.press(x, y); // 1st tap (suppressed by the hold)
    s.press(x, y); // 2nd tap → KEYS
  }, { x: CLIP_L0S0.x, y: CLIP_L0S0.y });
  await releaseS(DECK_KEYS_OVERDUB.x, DECK_KEYS_OVERDUB.y); // harmless keyboard-off inside KEYS
  await expect.poll(() => singleState().then((st) => st.mode), { timeout: 5000 }).toBe('keys');

  // CC 98 is INACTIVE while KEYS owns the device (no view flip out of KEYS).
  const viewBefore = (await singleState()).activeView;
  await viewFlipS();
  await expect.poll(() => singleState().then((st) => st.mode)).toBe('keys');
  expect((await singleState()).activeView, 'view unchanged — CC 98 swallowed in KEYS').toBe(viewBefore);

  // (1) Empty clip → silent until a key sounds.
  const before = await readScopePeakOverWindow(page, 's-scp', 500);
  expect(before.rms, 'silent before a KEYS key is played (empty clip)').toBeLessThan(0.03);

  // (2) Hold a keyboard pad on the lone device → live audition → AUDIBLE.
  await pressS(KEY_A.x, KEY_A.y); // keyboard band (clear of the released hold pad)
  const during = await readScopePeakOverWindow(page, 's-scp', 1200);
  expect(during.polls, 'SCOPE polled across the window').toBeGreaterThan(0);
  expect(during.rms, 'audible RMS while a single-unit KEYS key is held').toBeGreaterThan(0.03);
  expect(during.nonzeroSamples, 'structured signal, not a glitch').toBeGreaterThan(50);
  expect(during.rms, 'the keypress raised the output').toBeGreaterThan(before.rms + 0.02);
  await releaseS(KEY_A.x, KEY_A.y);
  await expect
    .poll(async () => (await readScopePeakOverWindow(page, 's-scp', 400)).rms, { timeout: 5000 })
    .toBeLessThan(0.03);

  // (3) QUEUE-REC → recording begins on the loop wrap; played notes land in the clip.
  await pressS(KEYS_QREC.x, KEYS_QREC.y);
  await expect.poll(() => isRecording(page), { timeout: 6000 }).toBe(true);
  for (const k of [KEY_ROOT, KEY_A, KEY_B]) {
    await pressS(k.x, k.y);
    await page.waitForTimeout(120);
    await releaseS(k.x, k.y);
    await page.waitForTimeout(120);
  }
  await expect.poll(() => clipSteps(page), { timeout: 6000 }).toBeGreaterThan(0);

  // (4) EXIT stops the take (stays in KEYS); the captured clip loops back audibly.
  await pressS(KEYS_EXIT.x, KEYS_EXIT.y);
  await expect.poll(() => isRecording(page), { timeout: 5000 }).toBe(false);
  const playback = await readScopePeakOverWindow(page, 's-scp', 1600);
  expect(playback.rms, 'the recorded notes sound back on the loop').toBeGreaterThan(0.03);
  expect(playback.nonzeroSamples, 'structured playback, not a glitch').toBeGreaterThan(50);

});

test('@launchpad KEYS record — queue-record captures played notes into the clip; they SOUND on the next loop', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'r');
  await seedEmptyClip(page, 'r-cp');

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstall?: (id: string) => Promise<boolean> };
    return w.__launchpadTestInstall ? await w.__launchpadTestInstall('r-cp') : false;
  });
  expect(installed, 'simulated Launchpad install hook present').toBe(true);

  await setTransport(page, 1);
  // Enter via OVERDUB (additive) so recorded notes accumulate deterministically.
  await enterKeys(page, DECK_KEYS_OVERDUB);
  await expect.poll(() => keysState(page).then((s) => s?.mode), { timeout: 15_000 }).toBe('keys');

  // QUEUE-REC → arm → recording begins on the loop wrap.
  await pressL(page, KEYS_QREC.x, KEYS_QREC.y);
  await expect.poll(() => isRecording(page), { timeout: 6000 }).toBe(true);

  // Play several notes across a couple of loops → they land in the clip.
  for (const k of [KEY_ROOT, KEY_A, KEY_B, KEY_A, KEY_ROOT]) {
    await pressL(page, k.x, k.y);
    await page.waitForTimeout(120);
    await releaseL(page, k.x, k.y);
    await page.waitForTimeout(120);
  }
  await expect.poll(() => clipSteps(page), { timeout: 6000 }).toBeGreaterThan(0);

  // EXIT (1st tap) stops recording but stays in KEYS; the clip keeps playing.
  await pressL(page, KEYS_EXIT.x, KEYS_EXIT.y);
  await expect.poll(() => isRecording(page), { timeout: 15_000 }).toBe(false);

  // With keys released + recording stopped, the RECORDED notes play back on the
  // loop → AUDIBLE RMS (proves the captured clip actually sounds). POLLED, not
  // a one-shot window: a fixed 1600 ms capture races the loop phase — the
  // recorded notes may have just played and not recur until the next pass,
  // and a loaded CI shard stretches the loop period (posterbox run 29171101494
  // failed both attempts exactly here while 180+ shard-mates passed). The
  // loop guarantees recurrence, so retrying windows under a generous ceiling
  // is assertion-equivalent and load-tolerant; silence still fails.
  let playback = { rms: 0, nonzeroSamples: 0 };
  await expect
    .poll(async () => {
      playback = await readScopePeakOverWindow(page, 'r-scp', 1600);
      return playback.rms;
    }, { timeout: 20_000, message: 'the recorded notes sound back on the loop' })
    .toBeGreaterThan(0.03);
  expect(playback.nonzeroSamples, 'structured playback, not a glitch').toBeGreaterThan(50);

});
