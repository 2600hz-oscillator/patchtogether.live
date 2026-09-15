// The NORMALIZE / DENOISE action seam against a REAL Y.Doc + UndoManager
// (the `samsloop-rack-budget.test.ts` pattern), with the runner injected as
// the INLINE core (real dsp, no Worker) and a fake upload decoder.
//
// Pinned here, because no other gate can see it:
//   * the commit SHAPE — REC's own: every upload key gone, a fresh `sample`
//     at the source bits, `sampleLength`/`sampleRate` re-written, the WINDOW
//     untouched, the signature moved (the poll observable);
//   * NOT UNDOABLE (owner ruling) — the undo stack is exactly as long after
//     the write as before, and `undo()` does not bring the upload back;
//   * every refusal lands the seam's OWN sentence (identity, not a copy), is
//     sig-stamped so it retires when the sample changes, and writes nothing;
//   * the H10 re-check: a sample that changes while the worker is busy makes
//     the result STALE and it is discarded, not written over the newer one;
//   * the DENOISE marker makes a second press refuse;
//   * the ledger: a bare rack press records delivered:true (the DOWNLOAD
//     rule), a missing node records delivered:false.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import type { ModuleNode } from '$lib/graph/types';
import { resolveSamsloopSource, type SamsloopData } from '$lib/audio/modules/samsloop';
import {
  buildRecordedSample,
  decodeRecordedPcm,
  quantizeF32ToI16,
  SAMSLOOP_UPLOAD_DATA_KEYS,
} from '$lib/audio/modules/samsloop-record';
import { runSamsloopTransform } from '$lib/audio/samsloop-transform/transform-core';
import { auditionLog } from './audition-ledger';
import {
  denoiseSamsloopSample,
  normalizeSamsloopSample,
  transformSamsloopSample,
  SAMSLOOP_TRANSFORM_ALREADY_DENOISED,
  SAMSLOOP_TRANSFORM_NO_SAMPLE,
  SAMSLOOP_TRANSFORM_SAMPLE_CHANGED,
  SAMSLOOP_TRANSFORM_ENGINE_NOT_READY,
  samsloopTransformRefusalText,
  type SamsloopTransformDeps,
} from './samsloop-face-actions';
import {
  samsloopTransformStatus,
  setSamsloopTransformStatus,
} from './samsloop/samsloop-transform-status.svelte';

const ID = 'samsloop-transform-unit';
const RATE = 24_000;

const deps: SamsloopTransformDeps = {
  run: async (req) => runSamsloopTransform(req),
  now: () => 1234,
};

function quietTone(seconds = 0.5): Float32Array {
  const n = Math.floor(RATE * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.05;
  return x;
}

function recordOf(f32: Float32Array, bits: 16 = 16) {
  const q = quantizeF32ToI16(f32);
  return buildRecordedSample(new Uint8Array(q.buffer, q.byteOffset, q.byteLength), RATE, bits, 1, 1).sample;
}

function despawn(): void {
  ydoc.transact(() => {
    if (patch.nodes[ID]) delete patch.nodes[ID];
  }, LOCAL_ORIGIN);
  setSamsloopTransformStatus(ID, null);
}

function spawn(data: Record<string, unknown>, params: Record<string, number> = { start: 0.25, end: 0.75 }): void {
  ydoc.transact(() => {
    patch.nodes[ID] = {
      id: ID,
      type: 'samsloop',
      domain: 'audio',
      position: { x: 0, y: 0 },
      params: { ...params },
      data: { ...data },
    } as unknown as ModuleNode;
  }, LOCAL_ORIGIN);
  undoManager.stopCapturing();
}

const dataOf = () => (patch.nodes[ID] as ModuleNode).data as SamsloopData;
const sigOf = () => resolveSamsloopSource(dataOf())?.signature ?? 'empty';

beforeEach(() => {
  despawn();
  // A clean stack, so "the top step is the spawn" is a statement about THIS
  // test and not about a neighbour's despawn.
  undoManager.clear();
});
afterEach(despawn);

describe('the commit is REC\'s shape, and it is NOT an undo step', () => {
  it('record source: a fresh `sample` at the source bits, window untouched, signature moved, undo stack unchanged', async () => {
    spawn({ sample: recordOf(quietTone()), sampleLength: 12_000, sampleRate: RATE });
    const before = sigOf();
    const stackBefore = undoManager.undoStack.length;

    expect(await normalizeSamsloopSample(ID, deps)).toBe(true);

    const d = dataOf();
    expect(d.sample?.bits).toBe(16);
    expect(d.sample?.channels).toBe(1);
    expect(d.sample?.rate).toBe(RATE);
    expect(d.sample?.recordedAt).toBe(1234);
    expect(d.sampleLength).toBe(12_000);
    expect(d.sampleRate).toBe(RATE);
    expect(sigOf()).not.toBe(before);
    // The window is a FRACTION and the frame count did not change: untouched.
    const p = (patch.nodes[ID] as ModuleNode).params;
    expect(p.start).toBe(0.25);
    expect(p.end).toBe(0.75);
    // The bytes really moved: the peak is now full scale.
    let peak = 0;
    for (const v of decodeRecordedPcm(d.sample!, 'mix')) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBe(1);
    // NOT UNDOABLE — the owner's ruling, expressed as the origin axis. The
    // stack did not grow, and the step on TOP of it is still the SPAWN: one
    // undo removes the node, not the rewrite. (A tracked commit would have
    // put the rewrite on top and `undo()` would have restored the old bytes.)
    expect(undoManager.undoStack.length, 'no undo entry for the rewrite').toBe(stackBefore);
    undoManager.undo();
    expect(patch.nodes[ID], 'the top undo step was the spawn, not the transform').toBeUndefined();
  });

  it('upload source: every SAMSLOOP_UPLOAD_DATA_KEYS key is gone and a `sample` record stands in its place', async () => {
    const x = quietTone();
    spawn({
      fileBytesB64: 'AAAA',
      fileSize: 3,
      fileMime: 'audio/mpeg',
      fileName: 'take.mp3',
      sampleLength: x.length,
      sampleRate: RATE,
    });
    expect(SAMSLOOP_UPLOAD_DATA_KEYS.length, 'the list is not empty').toBeGreaterThan(0);
    const before = sigOf();
    expect(before).toMatch(/^bytes:/);

    const ok = await normalizeSamsloopSample(ID, {
      ...deps,
      audioCtx: () => ({}) as BaseAudioContext,
      decodeFile: async () => ({ ok: true, samples: x, sampleRate: RATE }),
    });
    expect(ok).toBe(true);

    const d = dataOf() as unknown as Record<string, unknown>;
    for (const k of SAMSLOOP_UPLOAD_DATA_KEYS) {
      if (k === 'sampleLength' || k === 'sampleRate') continue; // re-written from the encode
      expect(k in d, `${k} must be deleted`).toBe(false);
    }
    expect(d.sampleLength).toBe(x.length);
    expect(d.sampleRate).toBe(RATE);
    expect(resolveSamsloopSource(dataOf())?.kind).toBe('record');
    expect(sigOf()).toMatch(/^record:/);
  });

  it('upload source with the engine DOWN refuses before any decode', async () => {
    spawn({ fileBytesB64: 'AAAA', fileSize: 3, fileName: 'take.mp3' });
    const ok = await normalizeSamsloopSample(ID, { ...deps, audioCtx: () => undefined });
    expect(ok).toBe(false);
    expect(samsloopTransformStatus(ID, sigOf())?.text).toBe(SAMSLOOP_TRANSFORM_ENGINE_NOT_READY);
    expect(dataOf().fileBytesB64, 'nothing written').toBe('AAAA');
  });
});

describe('every refusal is VISIBLE, sig-stamped, and writes nothing', () => {
  it('NEGATIVE CONTROL: a node that has not pressed carries no status', () => {
    spawn({});
    expect(samsloopTransformStatus(ID, sigOf())).toBeNull();
  });

  it('a bare node → the seam\'s own NO-SAMPLE sentence, delivered:true (the DOWNLOAD rule)', async () => {
    spawn({});
    const seq = auditionLog().at(-1)?.seq ?? 0;
    expect(await normalizeSamsloopSample(ID, deps)).toBe(false);
    const st = samsloopTransformStatus(ID, sigOf());
    expect(st?.phase).toBe('refused');
    expect(st?.text).toBe(SAMSLOOP_TRANSFORM_NO_SAMPLE);
    const rec = auditionLog().find((r) => r.seq > seq && r.nodeId === ID);
    expect(rec?.seam).toBe('sample-normalize');
    expect(rec?.delivered).toBe(true);
    expect(dataOf().sample).toBeUndefined();
  });

  it('a MISSING node records delivered:false and nothing else', async () => {
    const seq = auditionLog().at(-1)?.seq ?? 0;
    expect(await denoiseSamsloopSample('samsloop-no-such-node', deps)).toBe(false);
    const rec = auditionLog().find((r) => r.seq > seq && r.nodeId === 'samsloop-no-such-node');
    expect(rec?.seam).toBe('sample-denoise');
    expect(rec?.delivered).toBe(false);
  });

  it('a SILENT sample → the dsp reason\'s sentence, bytes untouched', async () => {
    const silent = recordOf(new Float32Array(RATE));
    spawn({ sample: silent });
    const before = sigOf();
    expect(await normalizeSamsloopSample(ID, deps)).toBe(false);
    expect(samsloopTransformStatus(ID, before)?.text).toBe(samsloopTransformRefusalText('normalize', 'silent'));
    expect(sigOf()).toBe(before);
    expect(dataOf().sample?.bytesB64).toBe(silent.bytesB64);
  });

  it('a PAD → "no steady noise floor", bytes untouched (owner Q4)', async () => {
    const n = RATE * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * 110 * h * i) / RATE) / h;
      x[i] = 0.3 * v;
    }
    const pad = recordOf(x);
    spawn({ sample: pad });
    const before = sigOf();
    expect(await denoiseSamsloopSample(ID, deps)).toBe(false);
    const text = samsloopTransformStatus(ID, before)?.text;
    expect(text).toBe(samsloopTransformRefusalText('denoise', 'no-steady-noise-floor'));
    expect(text).toMatch(/no steady noise floor/i);
    expect(dataOf().sample?.bytesB64).toBe(pad.bytesB64);
  });

  it('a stale status RETIRES when the sample changes underneath it', async () => {
    spawn({});
    await normalizeSamsloopSample(ID, deps);
    expect(samsloopTransformStatus(ID, sigOf())).not.toBeNull();
    ydoc.transact(() => {
      (patch.nodes[ID] as ModuleNode).data!.sample = recordOf(quietTone());
    }, LOCAL_ORIGIN);
    expect(samsloopTransformStatus(ID, sigOf()), 'a line about the old sample must not paint').toBeNull();
  });

  it('H10: a sample that changes WHILE the worker runs makes the result stale — discarded, not written', async () => {
    spawn({ sample: recordOf(quietTone()) });
    const newer = recordOf(quietTone(0.3));
    const ok = await transformSamsloopSample(ID, 'normalize', {
      ...deps,
      run: async (req) => {
        // A REC stop / peer write lands mid-flight.
        ydoc.transact(() => {
          (patch.nodes[ID] as ModuleNode).data!.sample = newer;
        }, LOCAL_ORIGIN);
        return runSamsloopTransform(req);
      },
    });
    expect(ok).toBe(false);
    expect(samsloopTransformStatus(ID, resolveSamsloopSource({ sample: newer })?.signature ?? '')).toBeNull();
    // The refusal was stamped with the PRESSED signature, which is gone — it
    // is invisible by design; the newer sample is what survived.
    expect(dataOf().sample?.bytesB64).toBe(newer.bytesB64);
    expect(dataOf().sample?.recordedAt).toBe(1);
    void SAMSLOOP_TRANSFORM_SAMPLE_CHANGED;
  });
});

describe('the DENOISE marker', () => {
  it('a second DENOISE press refuses with the ALREADY-DENOISED sentence; a NORMALIZE after it still runs and CARRIES the marker', async () => {
    spawn({ sample: { ...recordOf(quietTone()), denoised: true as const } });
    const before = sigOf();
    expect(await denoiseSamsloopSample(ID, deps)).toBe(false);
    expect(samsloopTransformStatus(ID, before)?.text).toBe(SAMSLOOP_TRANSFORM_ALREADY_DENOISED);
    expect(sigOf()).toBe(before);

    expect(await normalizeSamsloopSample(ID, deps)).toBe(true);
    expect(dataOf().sample?.denoised).toBe(true);
    expect(sigOf()).not.toBe(before);
  });
});
