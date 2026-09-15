// Shared reads for the SAMSLOOP record specs. Not a spec file (leading `_`,
// same convention as _helpers.ts) so Playwright does not collect it.
//
// ⚠ WHY THIS EXISTS: what SAMSLOOP records at is a function of the machine,
// not of the code. The RATE switch is a REQUEST; `downsample` decimates by an
// INTEGER factor, so a 48 kHz AudioContext cannot produce 44.1 kHz and a
// 44.1 kHz one cannot produce 48. Hard-coding `expect(sample.rate).toBe(44100)`
// — which is what these specs used to do — is therefore an assertion about the
// RUNNER, and it was green only because it agreed with the old (wrong) tag.
// Ask the page what its context runs at and derive the expectation, so the
// assertion is renderer-independent by construction rather than by luck.

import type { Page } from '@playwright/test';

/** The live AudioContext's sample rate, as the tap will capture at. */
export async function readContextSampleRate(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { hasDomain?: (d: string) => boolean; getDomain?: (d: string) => { ctx?: { sampleRate?: number } } } | null;
    };
    const eng = w.__engine?.();
    if (!eng?.hasDomain?.('audio')) return 0;
    return eng.getDomain?.('audio')?.ctx?.sampleRate ?? 0;
  });
}

/** Mirror of `samsloopAchievedRate` for the e2e side. Kept tiny and stated
 *  in one line so the duplication is obviously the same rule; the authority
 *  is `$lib/audio/modules/samsloop-record`, pinned by its own unit tests. */
export function expectedAchievedRate(captureRate: number, switchRate: number): number {
  if (captureRate <= 0 || switchRate <= 0) return 0;
  const factor = captureRate <= switchRate ? 1 : Math.max(1, Math.round(captureRate / switchRate));
  return captureRate / factor;
}

export interface SamsloopSampleRead {
  bytesLen: number;
  rate: number;
  bits: number;
  channels: number;
  durationSec: number;
}

/** Read `node.data.sample`'s metadata, or null when nothing is recorded. */
export async function readSample(page: Page, nodeId: string): Promise<SamsloopSampleRead | null> {
  return await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { data?: { sample?: { byteLength: number; rate: number; bits: number; channels: number; durationSec: number } } }> };
    };
    const s = w.__patch.nodes[id]?.data?.sample;
    if (!s) return null;
    return {
      bytesLen: s.byteLength,
      rate: s.rate,
      bits: s.bits,
      channels: s.channels,
      durationSec: s.durationSec,
    };
  }, nodeId);
}

// ── DEFAULT-SHELL surface helpers (S2) ──────────────────────────────────────
//
// The card is gone from the default boot; SAMSLOOP's non-ranked affordances —
// the FILE cell, REC/EXPORT, the waveform — live in the dock full view.
// Everything is PANE-scoped because the lane tile ranks some of the same cell
// testids (`shell-cell-samsloop-trigger`).

import { expect } from '@playwright/test';

/** Open the SAMSLOOP dock full view and return the PANE locator. */
export async function openSamsloopPane(page: Page, id = 's') {
  await page.waitForFunction(
    () =>
      typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView ===
      'function',
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (i) => (globalThis as unknown as { __openDockFullView: (x: string) => void }).__openDockFullView(i),
    id,
  );
  const pane = page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);
  await expect(pane.getByTestId('samsloop-face-canvas')).toBeVisible({ timeout: 30_000 });
  return pane;
}

/** The NODE-keyed registry's recording flag — the recording-state observable
 *  on the shell (the card's REC/STOP label flip died with the card; the cell
 *  label is static by design). */
export async function samsloopIsRecording(page: Page, id = 's'): Promise<boolean> {
  return page.evaluate(
    (n) =>
      (globalThis as unknown as { __samsloopRecording: (x: string) => { recording: boolean } })
        .__samsloopRecording(n).recording,
    id,
  );
}

// ── TRANSFORM helpers (NORMALIZE / DENOISE) ─────────────────────────────────
//
// A deterministic Node-side WAV builder, so the transform spec ships NO new
// binary fixture: the repo's `samsloop-test.wav` is a 0.8-peak sine, which is
// neither quiet nor hissy. 16-bit mono PCM, the shape `parseWavManually`
// takes without an AudioContext round-trip, so the stored rate is the file's.

export interface TestWavSpec {
  rate: number;
  seconds: number;
  /** Sample value at frame `i`, time `t` seconds, in [-1, 1]. */
  sample: (i: number, t: number) => number;
}

export function buildTestWav(spec: TestWavSpec): Buffer {
  const n = Math.floor(spec.rate * spec.seconds);
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(spec.rate, 24);
  buf.writeUInt32LE(spec.rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, spec.sample(i, i / spec.rate)));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** mulberry32 — the seeded generator the dsp fixtures use, so the hiss is
 *  the same on every run. Returns values in [-0.5, 0.5). */
export function seededNoise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Segment AC RMS (the segment's own mean removed — a DC offset is not
 *  hiss, and DENOISE leaves it in place for NORMALIZE) / peak / mean of the
 *  PERSISTED `sample` bytes, decoded in-page at the record's own bit depth —
 *  the exact bytes the worklet plays. `segments` are [startSec, endSec]
 *  pairs; returns dBFS per segment plus the peak and the mean. */
export async function readSamplePcmStats(
  page: Page,
  nodeId: string,
  segments: Array<[number, number]>,
): Promise<{ peak: number; peakDb: number; mean: number; segDb: number[]; frames: number } | null> {
  return await page.evaluate(
    ({ id, segments }) => {
      const w = globalThis as unknown as {
        __patch: {
          nodes: Record<
            string,
            { data?: { sample?: { bytesB64: string; bits: number; channels: number; rate: number } } }
          >;
        };
      };
      const s = w.__patch.nodes[id]?.data?.sample;
      if (!s) return null;
      const bin = atob(s.bytesB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const bps = s.bits === 16 ? 2 : 1;
      const stride = bps * s.channels;
      const frames = Math.floor(bytes.byteLength / stride);
      const read = (i: number): number =>
        s.bits === 16 ? view.getInt16(i * stride, true) / 0x7fff : ((view.getUint8(i * stride) << 24) >> 24) / 0x7f;
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < frames; i++) {
        const v = read(i);
        peak = Math.max(peak, Math.abs(v));
        sum += v;
      }
      const segDb = segments.map(([a, b]) => {
        const i0 = Math.max(0, Math.floor(a * s.rate));
        const i1 = Math.min(frames, Math.floor(b * s.rate));
        let acc = 0;
        let m = 0;
        for (let i = i0; i < i1; i++) {
          const v = read(i);
          acc += v * v;
          m += v;
        }
        const n = Math.max(1, i1 - i0);
        const rms = Math.sqrt(Math.max(0, acc / n - (m / n) ** 2));
        return 20 * Math.log10(Math.max(rms, 1e-9));
      });
      return { peak, peakDb: 20 * Math.log10(Math.max(peak, 1e-9)), mean: sum / Math.max(1, frames), segDb, frames };
    },
    { id: nodeId, segments },
  );
}

/** The SAME statistics as `readSamplePcmStats`, read in Node from a WAV
 *  `buildTestWav` built — the "before" reading for an UPLOAD, which is not
 *  yet a `sample` record until a transform writes one. Same int16 / 0x7fff
 *  decode, same AC RMS, so the two are comparable to the quantization step. */
export function wavPcmStats(
  wav: Buffer,
  segments: Array<[number, number]>,
): { peak: number; peakDb: number; mean: number; segDb: number[]; frames: number } {
  const rate = wav.readUInt32LE(24);
  const frames = (wav.length - 44) >> 1;
  const read = (i: number): number => wav.readInt16LE(44 + i * 2) / 0x7fff;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < frames; i++) {
    const v = read(i);
    peak = Math.max(peak, Math.abs(v));
    sum += v;
  }
  const segDb = segments.map(([a, b]) => {
    const i0 = Math.max(0, Math.floor(a * rate));
    const i1 = Math.min(frames, Math.floor(b * rate));
    let acc = 0;
    let m = 0;
    for (let i = i0; i < i1; i++) {
      const v = read(i);
      acc += v * v;
      m += v;
    }
    const n = Math.max(1, i1 - i0);
    const rms = Math.sqrt(Math.max(0, acc / n - (m / n) ** 2));
    return 20 * Math.log10(Math.max(rms, 1e-9));
  });
  return { peak, peakDb: 20 * Math.log10(Math.max(peak, 1e-9)), mean: sum / Math.max(1, frames), segDb, frames };
}

/** How many pixels of the dock body's waveform canvas are LIT (not the
 *  #0a0c11 ground) — a cheap "the picture shows this sample" reading. */
export async function readWaveformLitPixels(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((id) => {
    const c = document.querySelector<HTMLCanvasElement>(
      `canvas[data-testid="samsloop-face-canvas"][data-node-id="${id}"]`,
    );
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return -1;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i]! + px[i + 1]! + px[i + 2]! > 120) lit++;
    }
    return lit;
  }, nodeId);
}
