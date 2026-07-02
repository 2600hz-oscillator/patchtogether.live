// e2e/tests/analog-vco-fm-sync.spec.ts
//
// ANALOG VCO FM×SYNC interaction, end-to-end. Two analog VCOs:
//   A = sine carrier; B = square modulator (B audio → A's FM input).
//   B.sine → A.fm                                    (FM)
//   A.morph → scope.ch1                              (observe A)
//   + optional sync wires for the sync configs.
//
// This is the frontend-integration backstop for the FM×sync MODEL the Faust ART
// validates with a TS mirror (node-web-audio-api can't host the worklet). We
// assert, against A's scope trace, the qualitative signatures of the configs:
//
//   Config 1 (B→FM A, no sync): turning A's FM depth up BENDS A's spectrum —
//     sidebands appear that the un-modulated carrier lacks. A stays non-silent.
//   Config 2 (B sync→A + B→FM A): hard-syncing A to B re-periodicises A onto
//     B's period AND the trace differs materially from the FM-only capture.
//
// (Configs 3 & 4 — feedback / mutual sync — are deterministic only with the
// 1-sample sync-propagation delay; in the live engine that separation comes
// from AudioNode block buffering. Their per-sample determinism + coupling is
// asserted in the ART scenario; here we cover the user-facing FM + one-way sync
// integration, mirroring the hard-sync e2e's scope+spectral approach.)

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const C4 = 261.6256;
const freqAtSemis = (semis: number) => C4 * Math.pow(2, semis / 12);

// A carrier at C4; B a non-integer interval up so its FM/sync clearly colours A.
const A_SEMIS = 0;     // C4
const B_SEMIS = 7;     // G4 ≈ 392 Hz (ratio ≈ 1.5)
const B_HZ = freqAtSemis(B_SEMIS);

/** Goertzel power at a single frequency over a Hann-windowed buffer. */
function powerAt(buf: Float32Array, sampleRate: number, freq: number): number {
  const n = buf.length;
  const k = (n * freq) / sampleRate;
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    const q0 = coeff * q1 - q2 + buf[i]! * win;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

/** Coarse spectral centroid (Hz) over 50..6000 Hz — brightness proxy. */
function spectralCentroid(buf: Float32Array, sampleRate: number): number {
  let num = 0;
  let den = 0;
  for (let hz = 50; hz <= 6000; hz += 50) {
    const m = Math.sqrt(powerAt(buf, sampleRate, hz));
    num += m * hz;
    den += m;
  }
  return num / den;
}

interface Capture {
  buf: Float32Array;
  sr: number;
}

interface PatchOpts {
  fmDepth: number; // A's fmAmount param
  syncBtoA: boolean; // B.sync_out → A.sync_in
}

async function captureA(page: Page, opts: PatchOpts): Promise<Capture> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  const edges = [
    // B's sine FMs A.
    {
      id: 'e_b_fm_a',
      from: { nodeId: 'b', portId: 'sine' },
      to: { nodeId: 'a', portId: 'fm' },
      sourceType: 'audio',
      targetType: 'audio',
    },
    // Observe A's morph output (a sine carrier at shape=0.5).
    {
      id: 'e_a_scope',
      from: { nodeId: 'a', portId: 'morph' },
      to: { nodeId: 'sc', portId: 'ch1' },
      sourceType: 'audio',
      targetType: 'audio',
    },
  ];
  if (opts.syncBtoA) {
    edges.push({
      id: 'e_b_sync_a',
      from: { nodeId: 'b', portId: 'sync' },
      to: { nodeId: 'a', portId: 'sync' },
      sourceType: 'audio',
      targetType: 'audio',
    });
  }

  await spawnPatch(
    page,
    [
      // A: sine carrier (morph shape=0.5 = pure sine), FM depth from opts.
      { id: 'a', type: 'analogVco', params: { tune: A_SEMIS, shape: 0.5, fmAmount: opts.fmDepth }, position: { x: 100, y: 100 } },
      // B: square modulator (morph shape=1) a fifth up.
      { id: 'b', type: 'analogVco', params: { tune: B_SEMIS, shape: 1 }, position: { x: 100, y: 360 } },
      { id: 'sc', type: 'scope', position: { x: 520, y: 100 } },
    ],
    edges,
  );

  await page.waitForTimeout(500);
  const result = await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const snap = eng.read(w.__patch.nodes['sc']!, 'snapshot') as { ch1?: Float32Array; sampleRate?: number } | null;
    if (!snap?.ch1) return null;
    let peak = 0;
    for (const v of snap.ch1) if (Math.abs(v) > peak) peak = Math.abs(v);
    if (peak < 0.2) return null;
    return { buf: Array.from(snap.ch1), sr: snap.sampleRate ?? 44100 };
  }, { timeout: 8000, polling: 150 });
  const value = (await result.jsonValue()) as { buf: number[]; sr: number };
  return { buf: new Float32Array(value.buf), sr: value.sr };
}

test.describe('Analog VCO FM × sync (two VCOs → scope)', () => {
  test('Config 1: B→FM A bends the carrier — FM depth grows the spectrum', async ({ page }) => {
    const dry = await captureA(page, { fmDepth: 0, syncBtoA: false });
    const wet = await captureA(page, { fmDepth: 0.6, syncBtoA: false });

    // Both are non-silent.
    const rms = (b: Float32Array) => {
      let s = 0;
      for (let i = 0; i < b.length; i++) s += b[i]! * b[i]!;
      return Math.sqrt(s / b.length);
    };
    expect(rms(dry.buf)).toBeGreaterThan(0.05);
    expect(rms(wet.buf)).toBeGreaterThan(0.05);

    // FM brightens A: the spectral centroid rises once FM is applied (energy
    // spreads to sidebands above the C4 carrier).
    const cDry = spectralCentroid(dry.buf, dry.sr);
    const cWet = spectralCentroid(wet.buf, wet.sr);
    expect(
      cWet,
      `FM did not brighten A (centroid dry ${cDry.toFixed(0)}Hz vs wet ${cWet.toFixed(0)}Hz)`,
    ).toBeGreaterThan(cDry * 1.1);

    // The waveform itself changes materially with FM applied.
    const n = Math.min(dry.buf.length, wet.buf.length);
    let diffSq = 0;
    let sigSq = 0;
    for (let i = 0; i < n; i++) {
      const d = wet.buf[i]! - dry.buf[i]!;
      diffSq += d * d;
      sigSq += dry.buf[i]! * dry.buf[i]!;
    }
    expect(Math.sqrt(diffSq / n) / (Math.sqrt(sigSq / n) + 1e-12)).toBeGreaterThan(0.2);
  });

  test('Config 2: B sync→A re-periodicises A onto B and differs from FM-only', async ({ page }) => {
    const fmOnly = await captureA(page, { fmDepth: 0.4, syncBtoA: false });
    const synced = await captureA(page, { fmDepth: 0.4, syncBtoA: true });

    // Hard sync forces A to repeat at B's period → A grows a strong component
    // at B's fundamental relative to its own. Normalise by A's C4 power so gain
    // differences cancel.
    const bRatioFmOnly = powerAt(fmOnly.buf, fmOnly.sr, B_HZ) / (powerAt(fmOnly.buf, fmOnly.sr, C4) + 1e-12);
    const bRatioSynced = powerAt(synced.buf, synced.sr, B_HZ) / (powerAt(synced.buf, synced.sr, C4) + 1e-12);
    expect(
      bRatioSynced,
      `synced A B-pitch ratio ${bRatioSynced.toExponential(2)} not > FM-only ${bRatioFmOnly.toExponential(2)} — sync had no effect`,
    ).toBeGreaterThan(bRatioFmOnly * 2 + 0.05);

    // And the synced trace differs materially from the FM-only one.
    const n = Math.min(fmOnly.buf.length, synced.buf.length);
    let diffSq = 0;
    let sigSq = 0;
    for (let i = 0; i < n; i++) {
      const d = synced.buf[i]! - fmOnly.buf[i]!;
      diffSq += d * d;
      sigSq += fmOnly.buf[i]! * fmOnly.buf[i]!;
    }
    expect(Math.sqrt(diffSq / n) / (Math.sqrt(sigSq / n) + 1e-12)).toBeGreaterThan(0.2);
  });
});

// ── PW/PM morph bug-fix integration: a single VCO's MORPH output → scope ──
async function captureMorph(
  page: Page,
  params: Record<string, number>,
): Promise<Capture> {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [
      { id: 'v', type: 'analogVco', params, position: { x: 100, y: 100 } },
      { id: 'sc', type: 'scope', position: { x: 520, y: 100 } },
    ],
    [
      {
        id: 'e_morph',
        from: { nodeId: 'v', portId: 'morph' },
        to: { nodeId: 'sc', portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );
  await page.waitForTimeout(500);
  const result = await page.waitForFunction(() => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, { id: string; type: string; domain: string }> };
    };
    const eng = w.__engine?.();
    if (!eng) return null;
    const snap = eng.read(w.__patch.nodes['sc']!, 'snapshot') as { ch1?: Float32Array; sampleRate?: number } | null;
    if (!snap?.ch1) return null;
    let peak = 0;
    for (const v of snap.ch1) if (Math.abs(v) > peak) peak = Math.abs(v);
    if (peak < 0.2) return null;
    return { buf: Array.from(snap.ch1), sr: snap.sampleRate ?? 44100 };
  }, { timeout: 8000, polling: 150 });
  const value = (await result.jsonValue()) as { buf: number[]; sr: number };
  return { buf: new Float32Array(value.buf), sr: value.sr };
}

test.describe('Analog VCO PW/PM on the MORPH output (bug fix)', () => {
  test('PW changes the morph duty at the square end (was dead in MORPH mode)', async ({ page }) => {
    // shape=1 (square morph end); narrow vs wide pulse width must reshape the
    // morph output. Before the fix this was a no-op (hardcoded 50% square).
    const narrow = await captureMorph(page, { tune: 0, shape: 1, pw: 0.2 });
    const wide = await captureMorph(page, { tune: 0, shape: 1, pw: 0.8 });

    // The fraction of positive samples (a duty proxy) must shift with PW.
    const duty = (b: Float32Array) => {
      let pos = 0;
      for (let i = 0; i < b.length; i++) if (b[i]! > 0) pos++;
      return pos / b.length;
    };
    expect(
      Math.abs(duty(narrow.buf) - duty(wide.buf)),
      `PW had no effect on the morph (duty narrow ${duty(narrow.buf).toFixed(2)} vs wide ${duty(wide.buf).toFixed(2)})`,
    ).toBeGreaterThan(0.15);

    // Waveform differs materially.
    const n = Math.min(narrow.buf.length, wide.buf.length);
    let diffSq = 0;
    let sigSq = 0;
    for (let i = 0; i < n; i++) {
      const d = narrow.buf[i]! - wide.buf[i]!;
      diffSq += d * d;
      sigSq += wide.buf[i]! * wide.buf[i]!;
    }
    expect(Math.sqrt(diffSq / n) / (Math.sqrt(sigSq / n) + 1e-12)).toBeGreaterThan(0.2);
  });
});
