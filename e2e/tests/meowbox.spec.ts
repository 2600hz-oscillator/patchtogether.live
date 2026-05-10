// e2e/tests/meowbox.spec.ts
//
// E2E for MEOWBOX V/oct tracking (PR fix/meowbox-voct).
//
// What was broken: meowbox's `pitch` input was declared `type: 'cv'` with
// `paramTarget: 'pitch'`, so a sequencer's V/oct CV (1V = 1 octave) was
// routed directly into a Faust hslider that interpreted the value as
// SEMITONES. Result: 1V from the sequencer produced only +1 semitone of
// shift instead of +12. Two side-effects of the fix:
//
//   (a) the cable type changed from `cv` to `pitch`, which means cables
//       from a sequencer's pitch output (polyPitchGate) now connect with
//       matching semantics (engine resolveConnection: poly→pitch routes
//       lane 0).
//   (b) the meowbox Faust DSP gained an audio-rate `pitch` input
//       channel that consumes V/oct directly via `261.6256 * 2^volts`.
//
// E2E coverage here:
//
//  1. The Sequencer→MEOWBOX cable connects without engine errors AND the
//     resulting audio flows through to AudioOut at audible RMS. This is
//     the regression guard for the type-change — under the old 'cv' port,
//     swapping a fresh patch would have wired silently into an AudioParam.
//
//  2. The sequencer's emitted V/oct values for octave-spaced steps
//     (C3=-1V, C4=0V, C5=+1V) form the canonical 1V/oct sequence. This is
//     read directly off the sequencer via `engine.read(node, 'pitchVOct')`
//     — the upstream contract that the meowbox now consumes correctly.
//
//  Pitch-fidelity FFT measurements at the meowbox output are pinned in the
//  ART suite (art/scenarios/meowbox/voct-tracking.test.ts) — the meowbox
//  formant filter colors the spectrum heavily so per-note FFT-via-scope is
//  not a reliable assertion in the browser.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

interface ScopeSnapshot { ch1?: Float32Array }

async function readScopeRms(page: Page, scopeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        read: (n: { id: string; type: string; domain: string }, k: string) => unknown;
      } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return 0;
    const node = w.__patch.nodes[id];
    if (!node) return 0;
    const snap = eng.read(node, 'snapshot') as ScopeSnapshot | undefined;
    if (!snap || !snap.ch1) return 0;
    let s = 0;
    for (let i = 0; i < snap.ch1.length; i++) s += snap.ch1[i]! * snap.ch1[i]!;
    return Math.sqrt(s / snap.ch1.length);
  }, scopeId);
}

/** Read the V/oct value the sequencer is currently emitting on lane 0 of
 *  its polyPitchGate output. Source of truth: sequencer.ts's `read('pitchVOct')`. */
async function readSeqVOct(page: Page, seqId: string): Promise<number | null> {
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
    const v = eng.read(node, 'pitchVOct');
    return typeof v === 'number' ? v : null;
  }, seqId);
}

async function setSeqPattern(page: Page, seqId: string, midi: number): Promise<void> {
  await page.evaluate(
    ({ id, m }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const seq = w.__patch.nodes[id];
        if (!seq) return;
        if (!seq.data) seq.data = {};
        seq.data.steps = Array.from({ length: 32 }, () => ({ on: true, midi: m, chord: 'mono' }));
      });
    },
    { id: seqId, m: midi },
  );
}

test.describe('MEOWBOX V/oct integration', () => {
  test('Sequencer → MEOWBOX → Scope → AudioOut produces audible RMS via the new pitch cable', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'seq',   type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
        { id: 'meow',  type: 'meowbox',   params: { pitch: 0, morph: 0.25, decay: 0.4, level: 1 } },
        { id: 'scope', type: 'scope',     params: {} },
        { id: 'out',   type: 'audioOut',  params: { master: 0.1 } },
      ],
      [
        { id: 'e-gate',  from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'meow', portId: 'gate' },  sourceType: 'gate', targetType: 'gate' },
        // The load-bearing edge: sequencer's polyPitchGate output → meowbox's
        // 1V/oct pitch input. The engine routes lane 0 (root pitch) via a
        // splitter (see resolveConnection in poly.ts).
        { id: 'e-pitch', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'meow', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
        { id: 'e-tap',   from: { nodeId: 'meow', portId: 'L' },    to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
        { id: 'e-out',   from: { nodeId: 'scope', portId: 'ch1_out' }, to: { nodeId: 'out', portId: 'L' },  sourceType: 'audio', targetType: 'audio' },
      ],
    );

    // Drive C4 (MIDI 60 = 0V/oct).
    await setSeqPattern(page, 'seq', 60);

    // Wait for audio to flow.
    let rms = 0;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      rms = await readScopeRms(page, 'scope');
      if (rms > 0.0005) break;
      await page.waitForTimeout(100);
    }
    expect(rms, `MEOWBOX scope RMS via Sequencer pitch cable (got ${rms.toExponential(3)})`).toBeGreaterThan(0.0005);

    expect(errors.filter((e) => !e.includes('favicon')), `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('Sequencer emits canonical 1V/oct values: C3=-1V, C4=0V, C5=+1V (read off the source)', async ({ page }) => {
    // The contract on the upstream side of the meowbox cable. If this
    // assertion holds AND meowbox declares its pitch input as `type:'pitch'`
    // (verified in the unit test), then the audio-rate signal reaching the
    // Faust DSP is the standard 1V/oct CV, and the DSP's
    // `261.6256 * 2^pitch` formula tracks octaves correctly. The
    // meowbox-side end-to-end FFT is in the ART suite — see the file
    // header for why we don't repeat it here.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'seq',   type: 'sequencer', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.85 } },
        { id: 'meow',  type: 'meowbox',   params: { pitch: 0, morph: 0.25, decay: 0.4, level: 1 } },
      ],
      [
        { id: 'e-gate',  from: { nodeId: 'seq', portId: 'gate' },  to: { nodeId: 'meow', portId: 'gate' },  sourceType: 'gate', targetType: 'gate' },
        { id: 'e-pitch', from: { nodeId: 'seq', portId: 'pitch' }, to: { nodeId: 'meow', portId: 'pitch' }, sourceType: 'polyPitchGate', targetType: 'pitch' },
      ],
    );

    async function waitForVOct(expected: number, tolerance = 0.05): Promise<number | null> {
      // The sequencer updates lastEmittedVOct on every step boundary.
      // Wait up to 1.5s for the value to land within tolerance — at 240 BPM,
      // one 16th-note step is 62.5 ms so several steps fit easily.
      const deadline = Date.now() + 1500;
      let last: number | null = null;
      while (Date.now() < deadline) {
        last = await readSeqVOct(page, 'seq');
        if (last !== null && Math.abs(last - expected) < tolerance) return last;
        await page.waitForTimeout(40);
      }
      return last;
    }

    // C3 = MIDI 48 = -1 V/oct.
    await setSeqPattern(page, 'seq', 48);
    const vC3 = await waitForVOct(-1.0);
    expect(vC3, `C3 (MIDI 48) should emit -1 V/oct`).not.toBeNull();
    expect(Math.abs(vC3! - -1.0), `vOct@C3=${vC3}`).toBeLessThan(0.05);

    // C4 = MIDI 60 = 0 V/oct.
    await setSeqPattern(page, 'seq', 60);
    const vC4 = await waitForVOct(0.0);
    expect(vC4, `C4 (MIDI 60) should emit 0 V/oct`).not.toBeNull();
    expect(Math.abs(vC4! - 0.0), `vOct@C4=${vC4}`).toBeLessThan(0.05);

    // C5 = MIDI 72 = +1 V/oct.
    await setSeqPattern(page, 'seq', 72);
    const vC5 = await waitForVOct(1.0);
    expect(vC5, `C5 (MIDI 72) should emit +1 V/oct`).not.toBeNull();
    expect(Math.abs(vC5! - 1.0), `vOct@C5=${vC5}`).toBeLessThan(0.05);

    // The sequence forms an arithmetic progression at exactly 1V steps.
    expect((vC4! - vC3!), `C4-C3 step`).toBeCloseTo(1.0, 1);
    expect((vC5! - vC4!), `C5-C4 step`).toBeCloseTo(1.0, 1);

    expect(errors.filter((e) => !e.includes('favicon')), `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
