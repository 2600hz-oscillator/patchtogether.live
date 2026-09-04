// e2e/tests/doom-audio-output.spec.ts
//
// ⚠ DOOM SPECS ARE NORMALLY OFF-LIMITS — the standing owner ruling is
//   "do not [touch] doom in any way without specific approval". This file was
//   rewritten under a SPECIFIC approval given by the owner on 2026-08-18,
//   verbatim:
//     "okay see if you can go make the doom tests blurrier and less flakey,
//      just knowing doom renders and our kb logic and basic game nav works
//      is fine"
//   That approval covers THE SPECS ONLY — not video/modules/doom.ts, not the
//   WASM/WAD assets, not the netcode. See #1848 and e2e/tests/_doom-helpers.ts.
//
// LIVE end-to-end regression coverage for DOOM's stereo audio outputs.
//
// PR #421's video→audio CV/gate sweep covered DOOM's six event gates
// (evt_kill / evt_door / evt_gun_p1..p4) but NOT the stereo audio outs
// (audio_l / audio_r). This file closes that gap: real PatchEngine + real
// AudioContext + real DoomRuntime + real worklet, asserting a SCOPE actually
// sees the stereo signal arrive when patched.
//
// It also carries the LOUDNESS GUARD. Root cause of the original defect: the C
// mixer (i_pcmgen.c `int32_t out = accum >> 6;`) divides by 64, so a single SFX
// at full volume peaked at only ~254/32768 ≈ −42 dBFS — DOOM was ~40 dB too
// quiet since day one. The fix is a FIXED makeup gain + tanh soft-limiter in
// the PCM worklet (we do NOT touch the C / WASM). This spec proves the makeup
// actually lifts the audible level.
//
// ── WHAT MADE THIS THE #1 DOOM FLAKE, AND WHAT CHANGED (#1848) ─────────────
//
// The old probe held fire for a FIXED 24 × 80 ms and read the SCOPE analyser
// once per iteration from the Playwright side. Two separate defects:
//
//   1. THE INSTRUMENT WAS BLIND TO MOST OF THE AUDIO. The analyser window is
//      2048 samples ≈ 42 ms; sampling it every 80 ms means slightly more than
//      HALF the timeline was never looked at. A pistol shot is ~200 ms of
//      decaying noise but its PEAK is a handful of milliseconds — landing that
//      peak inside a sampled window was luck.
//   2. THE NUMBER OF SHOTS WAS RENDERER-DEPENDENT. DOOM's game clock is the
//      frame clock (see _doom-helpers.ts), so a fixed 1.92 s of held fire is
//      ~115 tics on a real GPU and ~15 under SwiftShader. The pistol's refire
//      is measured in TICS, so the loud events the probe was hunting for got
//      rarer exactly when the sampling got sparser.
//
// Both are fixed by MOVING THE ACCUMULATOR INTO THE PAGE (CLAUDE.md's
// instrument rule) and polling the ACCUMULATED maximum instead of an
// instantaneous read: a 20 ms page-side interval against a ~42 ms window
// OVERLAPS, so no sample of DOOM's output can slip between observations, and
// the test then simply holds fire until the accumulator has seen a loud frame
// — however many tics that takes on this machine.
//
// ⚠ TWO NEGATIVE CONTROLS, BOTH PERMANENT LEGS OF THIS TEST:
//
//   SPATIAL — a THIRD scope is spawned and left UNPATCHED. Same module, same
//     read path, same accumulator, no edge. It must stay at silence for the
//     whole run. Without it, "the accumulator saw a loud frame" would also be
//     satisfied by an accumulator reading noise, reading the wrong node, or
//     reading a shared bus — the exact failure mode of the repo's documented
//     "unwired LAYER INPUT passing on a dead canvas" case.
//   TEMPORAL — the accumulators are installed BEFORE the "Click to load DOOM"
//     button is pressed, and every scope must read silence while DOOM is not
//     running. This is what makes the later loudness a statement about DOOM
//     rather than about the page: the ONLY thing that changed between the two
//     reads is that the runtime started.
//
// ⚠ A FINDING WHILE REWRITING THIS (#1848): the old file carried a
// `test.fixme` claiming "idle nomonsters E1M1 with no input doesn't fire any
// channel" (task #78). That is FALSE on the real menu-driven path — measured
// peak 0.148 on audio_l immediately after the title walk, before a single shot
// (DOOM's menu-select sound is DSPISTOL and it is still ringing). So the
// keypress-driven SFX this file was waiting on for #78 is already there; the
// two permanently-fixme'd tests it left behind are deleted, and BOTH channels
// are asserted here instead of only audio_l.
//
// Skip semantics: DOOM requires both the WASM bundle (built locally via
// `bash packages/web/native/build-doom-wasm.sh`) AND the DOOM1.WAD asset.
// Either missing → test.skip() with a clear reason. CI builds both before
// running e2e; locally a developer who hasn't run the WASM build sees the skip
// rather than a noisy fail.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressUntilInLevel, waitTics } from './_doom-helpers';

/** The DOOM game surface — `doom/DoomSurface.svelte`, mounted by the shell's
 *  dock full view. It owns the runtime, the `__doomCards` hook, the keyboard
 *  capture and the "Click to load DOOM" gesture, so the faceplate has to be
 *  open before the WAD can be booted or a key can reach the marine. */
const SURFACE = 'doom-face-surface';

/** Open a node's dock faceplate through the app's own hook. The dock boot is
 *  SEQUENTIAL — it does not overlap the page load — so this is a real wait. */
async function openDoomFace(page: Page, nodeId: string): Promise<void> {
  await page.evaluate(
    (n) => (globalThis as unknown as { __openDockFullView(x: string): void }).__openDockFullView(n),
    nodeId,
  );
  await expect(page.getByTestId(SURFACE)).toBeVisible({ timeout: 20_000 });
}


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

/** What one scope's page-side accumulator has seen since it was installed. */
interface ScopeAccum {
  /** Largest |sample| across EVERY analyser frame observed. */
  peak: number;
  /** Largest per-frame RMS across every analyser frame observed. */
  rms: number;
  /** How many analyser frames the accumulator actually read. */
  samples: number;
  /** Wall-clock the accumulator has been running, ms. */
  elapsedMs: number;
}

/**
 * Install ONE page-side accumulator that watches every named scope.
 *
 * ⚠ This is the fix for the #1 flake in this file, and it is an INSTRUMENT fix,
 * not a threshold fix. Reading a scope once per Playwright round trip is one
 * CDP hop per sample ON THE SAME MAIN THREAD AS THE SUBJECT, and at an 80 ms
 * cadence against a ~42 ms analyser window it structurally cannot see about
 * half the signal. The interval here is 20 ms, so consecutive windows OVERLAP
 * and no DOOM output can pass unobserved.
 *
 * `samples` and `elapsedMs` come back with the result and go into the assertion
 * messages, so "the path is silent" and "the accumulator never ran" are
 * distinguishable from the failure output alone — they are not, from a bare
 * peak of 0.
 */
async function installScopeAccumulators(page: Page, scopeIds: string[]): Promise<void> {
  await page.evaluate((ids) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
      __doomScopeAccum?: Record<string, { peak: number; rms: number; samples: number; t0: number }>;
      __doomScopeTimer?: number;
    };
    if (w.__doomScopeTimer !== undefined) clearInterval(w.__doomScopeTimer);
    const now = performance.now();
    const acc: Record<string, { peak: number; rms: number; samples: number; t0: number }> = {};
    for (const id of ids) acc[id] = { peak: 0, rms: 0, samples: 0, t0: now };
    w.__doomScopeAccum = acc;
    w.__doomScopeTimer = setInterval(() => {
      const eng = w.__engine?.();
      if (!eng) return;
      for (const id of ids) {
        const node = w.__patch.nodes[id];
        if (!node) continue;
        const snap = eng.read(node, 'snapshot') as { ch1: Float32Array } | undefined;
        if (!snap || !snap.ch1) continue;
        let peak = 0;
        let sq = 0;
        for (let i = 0; i < snap.ch1.length; i++) {
          const v = snap.ch1[i]!;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          sq += v * v;
        }
        const rms = Math.sqrt(sq / Math.max(1, snap.ch1.length));
        const slot = acc[id]!;
        slot.samples++;
        if (peak > slot.peak) slot.peak = peak;
        if (rms > slot.rms) slot.rms = rms;
      }
      // 20 ms < the analyser's ~42 ms window ⇒ consecutive reads OVERLAP, so
      // the accumulator cannot miss a transient the way an 80 ms Playwright
      // poll did.
    }, 20) as unknown as number;
  }, scopeIds);
}

/** Read one accumulator without disturbing it. */
async function readAccum(page: Page, scopeId: string): Promise<ScopeAccum> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __doomScopeAccum?: Record<string, { peak: number; rms: number; samples: number; t0: number }>;
    };
    const a = w.__doomScopeAccum?.[id];
    if (!a) return { peak: -1, rms: -1, samples: 0, elapsedMs: 0 };
    return { peak: a.peak, rms: a.rms, samples: a.samples, elapsedMs: performance.now() - a.t0 };
  }, scopeId);
}

test.describe('DOOM audio: A-L / A-R reach a downstream SCOPE, above the old −42 dB floor', () => {
  // Cold WASM + 4 MB WAD + a menu walk + a held-fire burst that waits for the
  // renderer rather than assuming it. Generous ceiling; the assertions gate.
  test.setTimeout(180_000);

  test('in-level SFX (pistol) produce audible level on BOTH channels — and an unpatched scope stays silent', async ({
    page,
  }) => {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    await page.goto('/rack?seed=none');
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
    const scopeL = 'cons-scope-doom-l';
    const scopeR = 'cons-scope-doom-r';
    // THE NEGATIVE CONTROL. Same module, same read path, same accumulator —
    // and NO edge from DOOM. If this one ever goes loud, the probe is not
    // measuring the DOOM audio path and the two positive legs prove nothing.
    const scopeUnpatched = 'cons-scope-doom-control';

    await spawnPatch(
      page,
      [
        { id: doomId,          type: 'doom',  position: { x: 80,  y: 80  }, domain: 'video' },
        { id: scopeL,          type: 'scope', position: { x: 540, y: 80  }, domain: 'audio' },
        { id: scopeR,          type: 'scope', position: { x: 540, y: 320 }, domain: 'audio' },
        { id: scopeUnpatched,  type: 'scope', position: { x: 540, y: 560 }, domain: 'audio' },
      ],
      [
        {
          id: 'e-doom-l-scope',
          from: { nodeId: doomId, portId: 'audio_l' },
          to:   { nodeId: scopeL, portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        {
          id: 'e-doom-r-scope',
          from: { nodeId: doomId, portId: 'audio_r' },
          to:   { nodeId: scopeR, portId: 'ch1' },
          sourceType: 'audio',
          targetType: 'audio',
        },
        // scopeUnpatched deliberately has NO edge.
      ],
    );

    // Everything below reads through ONE page-side accumulator, installed
    // BEFORE the runtime is loaded so the temporal control below is honest.
    await installScopeAccumulators(page, [scopeL, scopeR, scopeUnpatched]);

    // ── NEGATIVE CONTROL, TEMPORAL LEG: silence while DOOM is NOT running ───
    // The accumulator must have actually taken samples (a peak of 0 from an
    // instrument that never looked is "never looked", not "silent" — and the
    // two are indistinguishable from the number alone, which is why the sample
    // count is asserted separately) and every scope must read silence.
    await expect
      .poll(async () => (await readAccum(page, scopeL)).samples, {
        timeout: 15_000,
        message:
          'the page-side scope accumulator never took a sample. Its later silence ' +
          'and its later loudness would BOTH be vacuous.',
      })
      .toBeGreaterThan(10);
    for (const [id, label] of [
      [scopeL, 'audio_l'],
      [scopeR, 'audio_r'],
      [scopeUnpatched, 'unpatched control'],
    ] as const) {
      const pre = await readAccum(page, id);
      expect(
        pre.peak,
        `${label}'s scope was already at ${pre.peak} BEFORE DOOM was loaded ` +
          `(${pre.samples} frames / ${Math.round(pre.elapsedMs)}ms). Something other ` +
          `than DOOM is feeding this probe, so the loudness assertions below would ` +
          `pass whether or not the DOOM audio path works.`,
      ).toBeLessThan(0.001);
    }

    await openDoomFace(page, doomId);
    const card = page.locator(`[data-testid="${SURFACE}"]`);
    await expect(card, 'DOOM surface mounts').toHaveCount(1);
    const loadBtn = card.locator('button.overlay').filter({ hasText: 'Click to load DOOM' });
    await expect(loadBtn).toBeVisible();
    await loadBtn.click();
    await expect(card.locator('.overlay'), 'load overlay clears').toHaveCount(0, {
      timeout: 30_000,
    });
    await card.click(); // focus/latch the surface so DOOM consumes our keys

    // BASIC GAME NAV: walk the title sequence into E1M1 by keyboard. Presses
    // until the marine exists rather than four presses on a wall-clock cadence
    // — see pressUntilInLevel.
    const presses = await pressUntilInLevel(page, doomId);
    expect(
      presses,
      `keyboard nav walked the DOOM title sequence into a level in ${presses} Enter ` +
        `presses. The vanilla walk is 4 (demo → menu → New Game → skill → E1M1); a ` +
        `much larger number means presses are being dropped, not that the test is slow.`,
    ).toBeLessThanOrEqual(12);

    // Let the sim run a real span of TICS in the level before judging anything
    // — renderer-independent by construction (see waitTics), and it proves the
    // game clock is advancing at all rather than assuming it.
    const ticked = await waitTics(page, doomId, 20, 20_000);
    expect(
      ticked,
      `DOOM's game clock did not advance 20 tics in the level (advanced ${ticked}). ` +
        `A frozen sim produces no SFX, so every audio assertion below would fail for ` +
        `a reason that has nothing to do with the audio path.`,
    ).toBeGreaterThanOrEqual(20);

    // ── Hold PRIMARY FIRE and wait for the accumulator to see a loud frame ──
    // KeyF is the documented MacBook-safe PRIMARY fire (see doomkeys.ts); Ctrl
    // is DOOM's secondary bind but macOS steals Ctrl+Arrow for Mission Control,
    // which is what made the original probe alternate between a faint shot and
    // total silence. Holding auto-repeats the pistol.
    //
    // ⚠ This POLLS the accumulated maximum. It does not sample-and-hope: the
    // accumulator has already seen every frame since installation, so the poll
    // only decides WHEN ENOUGH TICS HAVE PASSED for a shot to have happened —
    // which is precisely the renderer-dependent quantity we refuse to guess.
    await page.keyboard.down('f');
    try {
      await expect
        .poll(async () => (await readAccum(page, scopeL)).peak, {
          timeout: 45_000,
          intervals: [250, 500, 1000],
          message:
            'audio_l never reached an audible peak while primary fire was held. ' +
            'Either the PCM worklet makeup gain (the −42 dB fix) is missing, the ' +
            'video→audio bridge dropped the edge, or the key never reached DOOM.',
        })
        .toBeGreaterThan(0.08);
      // audio_r shares the SFX (the pistol is at the listener, so it pans
      // centre) but gets its own edge and its own GainNode — a bridge that
      // wires only the left channel is a real, previously untested defect.
      await expect
        .poll(async () => (await readAccum(page, scopeR)).peak, {
          timeout: 20_000,
          intervals: [250, 500, 1000],
          message:
            'audio_r stayed near silence while audio_l went loud — the stereo pair ' +
            'is half-wired (only the left GainNode reached the sink).',
        })
        .toBeGreaterThan(0.08);
    } finally {
      await page.keyboard.up('f');
    }

    const loudL = await readAccum(page, scopeL);
    const loudR = await readAccum(page, scopeR);

    // The makeup gain (24×) lifts a single SFX peak from ≈0.00775 (−42 dBFS) to
    // ≈0.18. 0.02 RMS is ~14 dB above the OLD single-SFX PEAK — a tolerant
    // witness that the makeup is live and the worklet did not go silent.
    expect(
      loudL.rms,
      `audio_l RMS (${loudL.rms}, peak ${loudL.peak}, ${loudL.samples} frames) is at the ` +
        `old −42 dB near-silence floor. With the makeup gain a fired pistol must lift ` +
        `RMS well above it.`,
    ).toBeGreaterThan(0.02);
    expect(
      loudR.rms,
      `audio_r RMS (${loudR.rms}, peak ${loudR.peak}, ${loudR.samples} frames) is at the ` +
        `old −42 dB near-silence floor.`,
    ).toBeGreaterThan(0.02);

    // ── NEGATIVE CONTROL, LEG 2: the UNPATCHED scope stayed silent ──────────
    // Read LAST, so it has been accumulating through the entire loud burst.
    // This is what separates "the probe read DOOM's audio_l" from "the probe
    // reads something loud that happens to be on the page".
    const control = await readAccum(page, scopeUnpatched);
    expect(
      control.samples,
      `the control scope's accumulator never ran (samples=${control.samples}) — its ` +
        `silence would be vacuous.`,
    ).toBeGreaterThan(5);
    expect(
      control.peak,
      `an UNPATCHED scope read ${control.peak} while DOOM was firing (${control.samples} ` +
        `frames). The probe is not measuring the doom→scope edge — it is reading a ` +
        `shared bus, the wrong node, or stale data, and the loudness assertions above ` +
        `prove nothing.`,
    ).toBeLessThan(0.001);
  });
});
