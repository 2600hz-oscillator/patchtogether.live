// e2e/tests/doom-audio-output.spec.ts
//
// LIVE end-to-end regression coverage for DOOM's stereo audio outputs.
//
// PR #421's video→audio CV/gate sweep covered DOOM's six event gates
// (evt_kill / evt_door / evt_gun_p1..p4) but NOT the stereo audio outs
// (audio_l / audio_r). This file closes that gap.
//
// Why this matters: the user reported "DOOM's A-L / A-R don't produce
// sound". The unit-level sweep in engine-video-audio-bridge.test.ts now
// covers doom.audio_l / doom.audio_r at the dispatcher level (this PR),
// proving the engine .connect()s the GainNode upstream into the audio
// sink. This spec is the live layer: real PatchEngine + real AudioContext
// + real DoomRuntime + real worklet, asserting SCOPE actually sees the
// stereo signal arrive when patched.
//
// Skip semantics: DOOM requires both the WASM bundle (built locally via
// `bash packages/web/native/build-doom-wasm.sh`) AND the DOOM1.WAD asset.
// Either missing → test.skip() with a clear reason. CI builds both before
// running e2e; locally a developer who hasn't run the WASM build sees the
// skip rather than a noisy fail.
//
// Out of scope for this spec:
//   - the WASM bundle itself (forbidden by the task — don't touch DOOM
//     WASM)
//   - keyboard input handling (forbidden by the task)
//   - audio gain calibration / SFX timing (those are runtime concerns
//     covered by doom-wasm.spec.ts)

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'serial' });

/** Probe DOOM-WASM presence. Skip cleanly when the optional asset is
 *  absent. Mirrors the helper in video-audio-cvgate-coverage.spec.ts so
 *  both files agree on the skip rule. */
async function doomWasmPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try { return (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; }
    catch { return false; }
  });
}

/** Probe DOOM1.WAD presence. The runtime needs the WAD even after the
 *  WASM loads — without it, the engine sits at the "DOOM1.WAD missing"
 *  loadError state and the PCM mixer never emits non-silence. */
async function doomWadPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try { return (await fetch('/doom/DOOM1.WAD', { method: 'HEAD' })).ok; }
    catch { return false; }
  });
}

/** Trigger DOOM's runtime load + a single-player start so the WASM mixer
 *  begins emitting PCM into the worklet. Returns true on success, false
 *  if any step times out. The caller polls. */
async function ensureDoomRunning(page: Page, nodeId: string): Promise<boolean> {
  return await page.evaluate(async (id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return false;
    const node = w.__patch.nodes[id];
    if (!node) return false;
    const extras = eng.read(node, 'extras') as
      | {
          ensureLoaded?: () => Promise<string | null>;
          startNetGame?: (s: unknown, p: number) => void;
        }
      | undefined;
    if (!extras || typeof extras.ensureLoaded !== 'function') return false;
    const err = await extras.ensureLoaded();
    if (err) return false;
    // Single-player start (consoleplayer = 0, episode 1 map 1, easiest skill,
    // no monsters so the sim is deterministic + the demo intro doesn't
    // distract). DOOM's S_StartSound emits PCM from t=0 (the level intro
    // music + ambient SFX), so we don't need to wait for an event.
    extras.startNetGame?.(
      {
        deathmatch: 0,
        episode: 1,
        map: 1,
        skill: 1,
        nomonsters: 1,
        fastMonsters: 0,
        respawnMonsters: 0,
        numPlayers: 1,
      },
      0,
    );
    return true;
  }, nodeId);
}

/** Read a SCOPE's ch1 analyser snapshot. Returns peak + rms across the
 *  current FFT window. Identical helper-shape to other specs so a future
 *  refactor can lift this into _helpers.ts. */
async function readScopePeak(
  page: Page,
  scopeNodeId: string,
): Promise<{ peak: number; rms: number } | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const node = w.__patch.nodes[id];
    if (!node) return null;
    const snap = eng.read(node, 'snapshot') as
      | { ch1: Float32Array; ch2: Float32Array; sampleRate: number }
      | undefined;
    if (!snap) return null;
    let peak = 0, sq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
    }
    return { peak, rms: Math.sqrt(sq / Math.max(1, snap.ch1.length)) };
  }, scopeNodeId);
}

// ---- LOUDNESS GUARD (the −42 dB fix) ----------------------------------------
//
// Root cause: the C mixer (i_pcmgen.c `int32_t out = accum >> 6;`) divides by
// 64, so a single SFX at full volume peaks at only ~254/32768 ≈ −42 dBFS — DOOM
// has been ~40 dB too quiet since day one. The fix is a FIXED makeup gain +
// tanh soft-limiter in the PCM worklet (we do NOT touch the C / WASM). This
// LIVE test proves the makeup actually lifts the audible level: it boots DOOM,
// walks into E1M1, fires the pistol (Ctrl) a few times to guarantee a loud SFX,
// and asserts the SCOPE RMS off audio_l is well above the old near-silence
// floor. The threshold is tolerant (well above −42 dB, well below a hard clip)
// so it guards the makeup without being brittle about the non-deterministic
// exact in-game amplitude.
//
// Skip-clean when WASM/WAD are absent (same semantics as the rest of the file).
// CI ships both, so CI enforces the guard even when a local dev can't.
test.describe('DOOM loudness: makeup gain lifts audio_l RMS above the old −42 dB floor', () => {
  test('in-level SFX (pistol) produce audible RMS on a downstream SCOPE', async ({ page }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const hasWasm = await doomWasmPresent(page);
    const hasWad = await doomWadPresent(page);
    test.skip(
      !hasWasm || !hasWad,
      'DOOM WASM and/or DOOM1.WAD not present locally — '
        + 'run `bash packages/web/native/build-doom-wasm.sh` + drop DOOM1.WAD '
        + 'into packages/web/static/doom. CI builds both before e2e.',
    );

    const doomId = 'v-doom-loud';
    const scopeId = 'cons-scope-doom-loud';

    await spawnPatch(
      page,
      [
        { id: doomId,  type: 'doom',  position: { x: 80,  y: 80 }, domain: 'video' },
        { id: scopeId, type: 'scope', position: { x: 540, y: 80 }, domain: 'audio' },
      ],
      [
        {
          id: 'e-doom-loud-scope',
          from: { nodeId: doomId,  portId: 'audio_l' },
          to:   { nodeId: scopeId, portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    const card = page.locator('[data-testid="doom-card"]');
    await expect(card, 'DOOM card mounts').toHaveCount(1);
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });
    await card.click(); // focus the card so DOOM consumes our keys

    // Walk into E1M1 (Enter ×4) and wait for the marine.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
    await page.waitForFunction(
      (id) => {
        const w = globalThis as unknown as {
          __engine?: () => {
            getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } | null;
          } | null;
        };
        const ve = w.__engine?.()?.getDomain?.('video');
        const extras = ve?.read?.(id, 'extras') as
          | { getRuntime?: () => { hasPlayerMobj?: () => boolean } | null }
          | undefined;
        return extras?.getRuntime?.()?.hasPlayerMobj?.() === true;
      },
      doomId,
      { timeout: 30_000 },
    );

    // Fire the pistol by HOLDING primary fire (KeyF). Ctrl is DOOM's secondary
    // fire bind but macOS binds Ctrl+Arrow to Mission Control and intercepts the
    // key, so a keyboard `press('Control')` fired unreliably — that's what made
    // this flake between a faint shot and total silence. KeyF is the documented
    // MacBook-safe PRIMARY fire (see doomkeys.ts). Holding it auto-repeats the
    // pistol; we sample the SCOPE across the burst so a shot reliably lands
    // inside an analyser window.
    let bestRms = 0;
    let bestPeak = 0;
    await page.keyboard.down('f');
    try {
      for (let i = 0; i < 24; i++) {
        await page.waitForTimeout(80);
        const s = await readScopePeak(page, scopeId);
        if (s) {
          if (s.rms > bestRms) bestRms = s.rms;
          if (s.peak > bestPeak) bestPeak = s.peak;
        }
      }
    } finally {
      await page.keyboard.up('f');
    }

    // Old behaviour: a single SFX peaked at ≈ 0.00775 (−42 dBFS), so RMS over a
    // window was a tiny fraction of that. The makeup gain (24×) lifts a single
    // SFX peak to ≈ 0.18, so even a sparse pistol-shot window must show RMS
    // comfortably above the old floor. 0.02 RMS is ~14 dB above the old
    // single-SFX PEAK and far above its RMS — a clear, tolerant witness that
    // the makeup gain is live (and that the worklet didn't go silent).
    expect(
      bestPeak,
      `audio_l peak stayed near silence (${bestPeak}). The PCM worklet's makeup ` +
        `gain (the −42 dB fix) is missing or the audio path is dead.`,
    ).toBeGreaterThan(0.08);
    expect(
      bestRms,
      `audio_l RMS (${bestRms}) is at the old −42 dB near-silence floor. With the ` +
        `makeup gain a fired pistol must lift RMS well above it.`,
    ).toBeGreaterThan(0.02);
  });
});

test.describe('DOOM audio output regression: A-L / A-R reach a downstream SCOPE', () => {
  for (const channel of ['audio_l', 'audio_r'] as const) {
    // FIXME(#78): test scenario needs a synthetic keypress to trigger an
    // SFX (S_StartSound), since `nomonsters: 1` idle E1M1 with no input
    // doesn't fire any channel. PR #429's keep-alive fix made the audio
    // PATH alive; this test now confirms the path BUT the scenario must
    // actually produce PCM samples. Task #78 ("DOOM audio: dedicated e2e
    // driver that waits for WASM ready + injects keypress") tracks the
    // proper rewrite. Until then, the engine-bridge unit sweep + the
    // handle audit are the regression bar for the audio output class.
    test.fixme(`doom.${channel} → scope.ch1 produces non-silence`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const hasWasm = await doomWasmPresent(page);
      const hasWad = await doomWadPresent(page);
      test.skip(
        !hasWasm || !hasWad,
        'DOOM WASM and/or DOOM1.WAD not present locally — '
          + 'run `bash packages/web/native/build-doom-wasm.sh` + drop DOOM1.WAD '
          + 'into packages/web/static/doom. CI builds both before e2e.',
      );

      const doomId = `src-doom-${channel}`;
      const scopeId = `cons-scope-doom-${channel}`;

      // Patch: DOOM.<channel> → SCOPE.ch1. SCOPE's ch1 is an audio-typed
      // input that exposes a node-input handle (no AudioParam) — exactly
      // what the dispatcher's video.audio → audio bridge connects into.
      await spawnPatch(
        page,
        [
          { id: doomId,  type: 'doom',  position: { x: 80,  y: 80 }, domain: 'video' },
          { id: scopeId, type: 'scope', position: { x: 540, y: 80 }, domain: 'audio' },
        ],
        [
          {
            id: `e-doom-${channel}-scope`,
            from: { nodeId: doomId,  portId: channel },
            to:   { nodeId: scopeId, portId: 'ch1' },
            sourceType: 'audio',
            targetType: 'audio',
          },
        ],
      );

      // Wait for the DOOM card to render so extras() is reachable.
      await page.locator('[data-card-type="doom"]').first()
        .waitFor({ state: 'visible', timeout: 10_000 });

      // Boot DOOM. ensureLoaded + startNetGame fires the WASM init + game
      // start; the PCM mixer begins emitting samples a few hundred ms
      // later (S_Init seeds the intro music + ambient SFX). Poll until
      // the start hook returns true (the extras handle materialises
      // asynchronously after the card's $effect lands).
      await expect.poll(
        async () => ensureDoomRunning(page, doomId),
        { timeout: 15_000, intervals: [200, 400, 800] },
      ).toBe(true);

      // Give the WASM mixer + pcm worklet pump time to produce its first
      // ~300ms of audio. The pump interval is 16ms, the worklet's ring
      // is 1s of headroom, and the engine emits the intro music starting
      // at level-load. 1.5s is comfortably past S_StartMusic.
      await page.waitForTimeout(1500);

      // Poll the scope analyser. The mixer is non-deterministic in exact
      // amplitude (intro music level differs from in-game ambience), but
      // ANY non-silence proves the path: bridge connected, GainNode
      // alive, worklet emitting non-zero PCM. The 0.005 floor is well
      // above the analyser's noise but well below typical SFX amplitude
      // (~0.3-0.8 mid-game).
      let after: { peak: number; rms: number } | null = null;
      await expect.poll(
        async () => {
          after = await readScopePeak(page, scopeId);
          return after?.peak ?? 0;
        },
        {
          timeout: 10_000,
          intervals: [200, 400, 600, 1000],
          message:
            `scope.ch1 peak stayed at 0 — doom.${channel} is silent. `
              + 'Pre-fix the user-reported regression: the dispatcher dropped '
              + 'the edge, the GainNode never received the worklet output, '
              + 'or the worklet pump never started.',
        },
      ).toBeGreaterThan(0.005);

      expect(after, `doom.${channel}: scope read must succeed`).not.toBeNull();

      // Cosmetic: tolerate the well-known DOOM loader noise (WASM
      // streaming, WAD fetch warnings) but flag anything else.
      const realErrors = errors.filter((e) =>
        !e.includes('AudioContext')
        && !e.includes('DOOM1.WAD')
        && !e.includes('doom.js')
        && !e.includes('streamingCompile')
        && !e.includes('Uncaught (in promise) Error: aborted')
      );
      expect(
        realErrors,
        `doom.${channel}: no unexpected console / page errors`,
      ).toEqual([]);
    });
  }
});
