// e2e/tests/launchpad-arp.spec.ts
//
// LAUNCHPAD **ARP** real-source-chain proof (the poly/MIDI discipline,
// CLAUDE.md): the single-mode KEYS arpeggiator must SEQUENCE a held chord into
// AUDIBLE notes at a real voice output — not just flip a state flag. The whole
// path is the real one a user drives, through the SAME decode/dispatch the
// hardware uses (installSimulatedLaunchpadSingle → the launchpad-control KEYS/arp
// wiring → the clip-audition side-channel drained by the clipplayer factory) into
// the real TIMELORDE-locked chain:
//
//   [sim Launchpad KEYS chord] → arp generator → pushAudition (lane 0)
//   clipplayer.pitch1 → VCO.pitch ; VCO.sine → VCA.audio ;
//   clipplayer.gate1  → VCA.cv    ; VCA.audio → SCOPE.ch1
//
// The clip is EMPTY so any sound is the ARP sequencing the held keys — NOT a
// pre-seeded pattern, and NOT the direct key audition (the arp SWALLOWS the held
// keys' direct audition and sounds its own sequence). This is the required
// real-source → module → audible-RMS test; an engine-direct arp unit test does
// NOT count.
//
// AUDIO RMS is asserted UNCONDITIONALLY (no capability gate): the audible path is
// Web Audio (SCOPE), not the renderer-/encoder-dependent class (WebGL pixels /
// H.264) that CLAUDE.md gates behind a capability probe — the shipped
// launchpad-keys-record / launchpad-clip-launch audio specs assert RMS the same
// way on CI. The deterministic __test_mode() state assertions run alongside it.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';
import { readScopePeakOverWindow } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

// KEYS bottom-row controls (unit L, y=0) + keyboard-band chord notes (y=1..6),
// matching launchpad-map. The three chord notes are the distinct pitches the
// keys-record spec also uses, so the pool is a real ≥2-note chord.
const KEY_A = { x: 0, y: 1 };
const KEY_B = { x: 2, y: 2 };
const KEY_C = { x: 4, y: 3 };

// KEYS scene column (SCENE_CCS, top→bottom = scene index 0..7). No-shift: scale
// select (0=major … 5=mixolydian, 6=chromatic) + ARP on/off (7). +shift: the arp
// control column (0 div+ · 1 div− · 2 up · 3 down · 4 up-down · 5 range+ · 6
// range− · 7 latch). CC 59 (index 3) is also the Clip view's KEYS entry button.
const SCENE_CCS = [89, 79, 69, 59, 49, 39, 29, 19] as const;
const KEYS_ENTRY_CC = SCENE_CCS[3]; // 59 — Clip right-column KEYS button
const SCALE_MINOR_CC = SCENE_CCS[1]; // 79 — no-shift scene 1 = 'minor'
const ARP_TOGGLE_CC = SCENE_CCS[7]; // 19 — no-shift scene 7 = arp on/off
const ARP_UPDOWN_CC = SCENE_CCS[4]; // 49 — +shift scene 4 = arp up-down
const ARP_DIV_DOWN_CC = SCENE_CCS[1]; // 79 — +shift scene 1 = arp div− (slower)
const CC_SHIFT = 98; // permanent top row — shift (tap latches)

async function setTransport(page: import('@playwright/test').Page, running: number) {
  await page.evaluate((run) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; params?: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const tls = Object.values(w.__patch.nodes).filter((n) => n.type === 'timelorde');
      if (tls.length === 0) {
        w.__patch.nodes['tl-arp'] = {
          id: 'tl-arp', type: 'timelorde', domain: 'audio', position: { x: 0, y: 0 },
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

/** Seed an EMPTY note clip at lane 0 / slot 0 (root 48 → the KEYS keyboard root). */
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

/** The full single-mode arp state (via __test_mode through the sim probe). */
async function arpState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __launchpadSingleSim?: {
        state: () => {
          singleView: string;
          mode: string;
          arpOn: boolean;
          arpPoolLen: number;
          arpDir: string;
          arpDivIndex: number;
          arpRangeIndex: number;
          arpLatch: boolean;
          shiftLatched: boolean;
          keysPressedCount: number;
        };
      };
    };
    return w.__launchpadSingleSim!.state();
  });
}

/** The clip-player's clip-0 scale (deterministic state check). */
async function clipScale(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { type?: string; data?: { clips?: Record<string, { scale?: string }> } }> };
    };
    const cp = Object.values(w.__patch.nodes).find((n) => n.type === 'clipplayer');
    return cp?.data?.clips?.['0']?.scale ?? null;
  });
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

test('@launchpad single-unit ARP — a held KEYS chord is SEQUENCED to audible RMS (real source → arp → voice)', async ({ page, rack, errorWatch }) => {
  await buildChain(page, 'p');
  await seedEmptyClip(page, 'p-cp');

  const installed = await page.evaluate(async () => {
    const w = globalThis as unknown as { __launchpadTestInstallSingle?: (id: string) => Promise<boolean> };
    return w.__launchpadTestInstallSingle ? await w.__launchpadTestInstallSingle('p-cp') : false;
  });
  expect(installed, 'single simulated Launchpad install hook present (VITE_E2E_HOOKS)').toBe(true);

  const pressS = (x: number, y: number) =>
    page.evaluate(({ x, y }) => {
      (globalThis as unknown as { __launchpadSingleSim?: { press: (x: number, y: number) => void } })
        .__launchpadSingleSim!.press(x, y);
    }, { x, y });
  // Tap a CC (press+release) on the lone device — view/scene/shift buttons.
  const ccTapS = (cc: number) =>
    page.evaluate((c) => {
      const s = (globalThis as unknown as { __launchpadSingleSim?: { cc: (cc: number, v: number) => void } })
        .__launchpadSingleSim!;
      s.cc(c, 127);
      s.cc(c, 0);
    }, cc);

  await setTransport(page, 1);

  // The lone device binds into the CLIP (note-editor) view. Enter KEYS via the
  // Clip right-column KEYS button (scene index 3), then pick a scale (minor).
  await expect.poll(() => arpState(page).then((s) => s.singleView)).toBe('clip');
  await ccTapS(KEYS_ENTRY_CC);
  await expect.poll(() => arpState(page).then((s) => s.mode), { timeout: 5000 }).toBe('keys');
  await ccTapS(SCALE_MINOR_CC);
  await expect.poll(() => clipScale(page), { timeout: 5000 }).toBe('minor');

  // (1) KEYS just opened on an EMPTY clip, arp OFF, no keys down → silent.
  {
    const s = await arpState(page);
    expect(s.arpOn, 'arp starts OFF').toBe(false);
  }
  const before = await readScopePeakOverWindow(page, 'p-scp', 500);
  expect(before.rms, 'silent before the arp sequences anything (empty clip)').toBeLessThan(0.03);

  // (2) Toggle ARP ON (no-shift scene 7).
  await ccTapS(ARP_TOGGLE_CC);
  await expect.poll(() => arpState(page).then((s) => s.arpOn), { timeout: 5000 }).toBe(true);

  // (3) HOLD a chord of KEYS notes (no release) → the arp's held set fills. The
  //     direct key audition is swallowed; only the arp sounds.
  await pressS(KEY_A.x, KEY_A.y);
  await pressS(KEY_B.x, KEY_B.y);
  await pressS(KEY_C.x, KEY_C.y);
  await expect.poll(() => arpState(page).then((s) => s.arpPoolLen), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

  // (4) The arp SEQUENCES the chord → AUDIBLE structured RMS over time. POLLED (a
  //     fresh window until it rings) so a loaded CI shard that starves the audio
  //     worklet past a couple of arp steps still passes; silence still fails.
  let out = { rms: 0, nonzeroSamples: 0, polls: 0 };
  await expect
    .poll(async () => {
      out = await readScopePeakOverWindow(page, 'p-scp', 800);
      return out.rms;
    }, { timeout: 15_000, message: 'the arp produces audible RMS at the voice output' })
    .toBeGreaterThan(0.03);
  expect(out.nonzeroSamples, 'structured signal (the arp is producing notes), not a glitch').toBeGreaterThan(50);
  expect(out.rms, 'the arp raised the output over the silent baseline').toBeGreaterThan(before.rms + 0.02);

  // (5) Arp STATE via __test_mode(): running, a non-empty pool, default direction
  //     'up' + default division index 3 (1x).
  {
    const s = await arpState(page);
    expect(s.arpOn, 'arp still ON').toBe(true);
    expect(s.arpPoolLen, 'the held chord is in the pool').toBeGreaterThan(0);
    expect(s.arpDir, 'default arp direction is up').toBe('up');
    expect(s.arpDivIndex, 'default arp division index is 1x (3)').toBe(3);
  }

  // (6) DIRECTION + DIVISION changes (KEYS + shift = the arp control column). A
  //     short shift tap LATCHES the alt layer; then scene 4 = up-down, scene 1 =
  //     div− (slower). Both mutate the live arp state deterministically.
  await ccTapS(CC_SHIFT); // tap → latch the shift layer
  await expect.poll(() => arpState(page).then((s) => s.shiftLatched)).toBe(true);
  await ccTapS(ARP_UPDOWN_CC);
  await expect.poll(() => arpState(page).then((s) => s.arpDir), { timeout: 5000 }).toBe('updown');
  await ccTapS(ARP_DIV_DOWN_CC);
  await expect.poll(() => arpState(page).then((s) => s.arpDivIndex), { timeout: 5000 }).toBe(4);

  // Still SEQUENCING after the param changes (the chord is still held).
  const still = await readScopePeakOverWindow(page, 'p-scp', 1000);
  expect(still.rms, 'the arp keeps sounding after direction/division changes').toBeGreaterThan(0.03);
});
