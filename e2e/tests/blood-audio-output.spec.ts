// e2e/tests/blood-audio-output.spec.ts
//
// LIVE end-to-end coverage for BLOOD's stereo audio outputs (Phase-2 ②).
//
// Until this PR the BLOOD module shipped audio_l / audio_r as DEAD ports (the
// PCM bridge was a stub). This wires the real capture pipeline: MultiVoc (SFX)
// + the OPL3 software-MIDI synth (music) mix into interleaved-stereo pages,
// driver_sdl's device-less wasm path exposes them via bpt_sdl_audio_pump, the
// shim's bpt_pump_audio drains them into a ring, and a blood-pcm AudioWorklet
// de-interleaves into audio_l / audio_r. This spec proves the WHOLE chain is
// audible: real PatchEngine + real AudioContext + real BloodRuntime + real
// worklet → a downstream SCOPE actually sees the signal arrive.
//
// Mirrors doom-audio-output.spec.ts (the proven pattern): the SCOPE's
// AnalyserNode reads the LIVE worklet output, which the blood.ts setInterval
// pump feeds — and the DOOM loudness test confirms process() runs under the
// headless null-sink, so the analyser sees real samples even with no hardware.
//
// Sound source: Blood plays level music (OPL3) + ambient/weapon SFX in-game,
// and a menu-cursor blip SFX on every menu move. We drive the menu (proven by
// blood-ingame.spec) into a level, fire the weapon, and sample the SCOPE across
// the whole sequence, taking the peak — so a single audible moment passes even
// though the exact in-game amplitude is non-deterministic.
//
// Renderer-independent for the AUDIO assertion (analyser reads the engine's own
// PCM, not the GL canvas) → SwiftShader-safe. Gated on blood-ready + e2e hooks.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const BLOOD_ID = 'blood-aud';
const SCOPE_ID = 'scope-aud';

// Build scancodes (match blood-keys.ts).
const SC_ENTER = 0x1c;
const SC_DOWN = 0xd0;
const SC_SPACE = 0x39;
const SC_RIGHT_CONTROL = 0x9d; // fire
const SC_2 = 0x03; // select a loud weapon (flare gun) in-game

/** Read a SCOPE's ch1 analyser snapshot → peak + rms. (Same shape as
 *  doom-audio-output's helper.) */
async function readScopePeak(page: Page, scopeId: string): Promise<{ peak: number; rms: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
    };
    const ad = w.__engine?.()?.getDomain('audio');
    const snap = ad?.read(id, 'snapshot') as { ch1?: Float32Array } | undefined;
    if (!snap || !snap.ch1) return null;
    let peak = 0, sq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
    }
    return { peak, rms: Math.sqrt(sq / Math.max(1, snap.ch1.length)) };
  }, scopeId);
}

test('BLOOD audio_l → SCOPE: the game-audio mixer produces audible signal in-game', async ({ page }) => {
  test.setTimeout(90_000);
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: BLOOD_ID, type: 'blood', position: { x: 100, y: 80 }, domain: 'video' },
      { id: SCOPE_ID, type: 'scope', position: { x: 560, y: 80 }, domain: 'audio' },
    ],
    [
      {
        id: 'e-blood-audio-scope',
        from: { nodeId: BLOOD_ID, portId: 'audio_l' },
        to: { nodeId: SCOPE_ID, portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  await page.getByTestId('blood-card').waitFor({ state: 'visible', timeout: 10_000 });
  const ready = await page
    .getByTestId('blood-ready')
    .waitFor({ state: 'visible', timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!ready, 'BLOOD engine did not reach ready (renderer/heap-sensitive on CI)');

  // Confirm the runtime + its PCM seam are reachable; skip on prod-preview.
  const seam = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
    };
    const ve = w.__engine?.()?.getDomain('video');
    const ex = ve?.read(id, 'extras') as
      | { getRuntime: () => { isInitialized: () => boolean; setKey: (sc: number, p: boolean) => void; getPcmFrames?: (n: number) => Float32Array } | null }
      | undefined;
    const rt = ex?.getRuntime();
    return { hasRt: !!rt, hasPump: typeof rt?.getPcmFrames === 'function' };
  }, BLOOD_ID);
  test.skip(!seam.hasRt, 'BLOOD runtime/extras unavailable (prod-preview)');
  expect(seam.hasPump, 'runtime exposes getPcmFrames (the PCM capture seam)').toBe(true);

  // Drive the menu into a level + generate SFX, sampling the SCOPE the whole
  // time. The blood.ts setInterval pump feeds the worklet → audio_l → SCOPE; we
  // just poll the analyser. Take the peak across the whole run.
  let bestPeak = 0;
  let bestRms = 0;
  const sampleInto = async () => {
    const s = await readScopePeak(page, SCOPE_ID);
    if (s) {
      if (s.peak > bestPeak) bestPeak = s.peak;
      if (s.rms > bestRms) bestRms = s.rms;
    }
  };
  const pressAndSample = async (sc: number, holdMs = 120, settleMs = 350) => {
    await page.evaluate(({ id, sc, holdMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
      };
      const ve = w.__engine?.()?.getDomain('video');
      const rt = (ve?.read(id, 'extras') as { getRuntime: () => { setKey: (s: number, p: boolean) => void } | null } | undefined)?.getRuntime();
      if (!rt) return;
      rt.setKey(sc, true);
      setTimeout(() => rt.setKey(sc, false), holdMs);
    }, { id: BLOOD_ID, sc, holdMs });
    await page.waitForTimeout(settleMs);
    await sampleInto();
  };

  const holdFire = (down: boolean) =>
    page.evaluate(({ id, down }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
      };
      const ve = w.__engine?.()?.getDomain('video');
      const rt = (ve?.read(id, 'extras') as { getRuntime: () => { setKey: (s: number, p: boolean) => void } | null } | undefined)?.getRuntime();
      rt?.setKey(0x9d, down); // SC_RIGHT_CONTROL = fire
    }, { id: BLOOD_ID, down });

  // Drive into a level with the PROVEN blood-ingame nav (8 keys, 650ms settle).
  for (const sc of [SC_ENTER, SC_ENTER, SC_ENTER, SC_DOWN, SC_ENTER, SC_ENTER, SC_SPACE, SC_ENTER]) await pressAndSample(sc, 120, 650);
  await page.waitForTimeout(900);

  // In-level: ambient sound sprites + weapon fire feed MultiVoc → the blood.ts
  // pump → the worklet → audio_l → SCOPE. Sample the analyser across a dwell +
  // a held-fire burst (select the flare gun first), taking the peak.
  await pressAndSample(SC_2, 120, 300);
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(80); await sampleInto(); }
  await holdFire(true);
  for (let i = 0; i < 24; i++) { await page.waitForTimeout(80); await sampleInto(); }
  await holdFire(false);

  // eslint-disable-next-line no-console
  console.log(`[blood-audio] audio_l SCOPE peak=${bestPeak.toFixed(4)} rms=${bestRms.toFixed(4)}`);

  // ANY clear non-silence proves the whole chain: driver_sdl capture pump →
  // MultiVoc mix → bpt ring → blood-pcm worklet → audio_l → SCOPE. MultiVoc
  // outputs near-full-scale s16, so a real SFX/music moment lands well above
  // this tolerant floor (the analyser noise floor is ~1e-4).
  expect(
    bestPeak,
    `audio_l peak stayed near silence (${bestPeak}) — the BLOOD PCM capture pipeline is not ` +
      `producing sound (driver_sdl pump / MultiVoc mix / worklet / audio_l bridge is dead).`,
  ).toBeGreaterThan(0.01);
});
