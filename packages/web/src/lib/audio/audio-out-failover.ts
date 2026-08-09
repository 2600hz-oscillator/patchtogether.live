// packages/web/src/lib/audio/audio-out-failover.ts
//
// THE TERMINAL SINK'S DEGRADED TAIL — and the runtime path to it.
//
// Split out of `audio-out.ts` for ONE reason: `audio-out.ts` imports the
// compiled limiter worklet as `@patchtogether.live/dsp/dist/master-limiter.js
// ?url`, which only resolves against a built DSP dist. Keeping the failover
// logic in a dist-free module means the highest-risk change in the audio-health
// PR is covered by a PURE UNIT TEST that runs on every unit lane, with no DSP
// build, no AudioContext, and no capability probe. A gate that can only run in
// a heavyweight lane is a gate that quietly stops running.
//
// It lives in `lib/audio/` rather than `lib/audio/modules/` deliberately: the
// doc-page manifest parser globs `modules/*.ts` and warns on any file with no
// module def in it, and its exclusion filter is a hand-maintained denylist that
// concurrent PRs collide on. A helper that is not a def does not belong there.
//
// ── The hole this closes ────────────────────────────────────────────────────
// `audioOutDef.factory`'s `try/catch` covers `audioWorklet.addModule` and node
// CONSTRUCTION. That is LOAD TIME ONLY. A throw inside the master limiter's
// `process()` happens on the render thread after construction succeeded, so the
// catch cannot see it — and per the Web Audio spec the node then "output[s]
// silence throughout its lifetime". The limiter is the TERMINAL node, so that
// silences the ENTIRE RACK, permanently, while `ctx.state` stays `'running'` —
// the click-to-resume overlay never appears and the user sees a dead app whose
// only recourse is a page reload.
//
// The hard-clip fallback the load path already built was, until this PR,
// UNREACHABLE from that failure.

import { MASTER_CEILING, MASTER_CEILING_DB } from '../../../../dsp/src/lib/master-limiter-dsp';

/** A hard-clip curve at the ceiling, for the degraded path only. */
export function ceilingClipCurve(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.max(-MASTER_CEILING, Math.min(MASTER_CEILING, x));
  }
  return c;
}

/** A WaveShaper hard-clipping at the ceiling — the degraded tail, reachable
 *  from BOTH the load-time catch and the runtime latch. Memoryless, hence still
 *  incapable of ducking the sub the way a 4:1 compressor did. */
export function buildCeilingClipper(ctx: BaseAudioContext): WaveShaperNode {
  const clip = ctx.createWaveShaper();
  clip.curve = ceilingClipCurve();
  clip.oversample = '4x';
  return clip;
}

/**
 * Swap a LATCHED limiter out of the terminal path and put the hard clipper in.
 *
 * Rewires `merger → clip → (destination + every tap)` and drops the dead node.
 * Returns the new tail.
 *
 * ⚠ This is the ONLY place in the audio-health PR that changes audio behaviour,
 * and it changes it only in a state that is currently PERMANENT SILENCE.
 *
 * Every `disconnect` is defended: `dispose()` may have raced the latch, and a
 * throw here would leave the rack silent — i.e. would reproduce the bug this
 * function exists to fix.
 */
export function failoverTerminalTailToClip(
  ctx: BaseAudioContext,
  dead: AudioNode,
  merger: AudioNode,
  sinks: readonly AudioNode[],
): WaveShaperNode {
  const clip = buildCeilingClipper(ctx);
  // Drop the dead node FIRST so it cannot double-sum into the destination in
  // the (impossible-per-spec, but cheap to defend) case that it revives.
  try { merger.disconnect(dead); } catch { /* already gone */ }
  try { dead.disconnect(); } catch { /* already gone */ }
  merger.connect(clip);
  for (const s of sinks) clip.connect(s);
  console.warn(
    '[audio-out] master limiter LATCHED at runtime — the whole rack would be ' +
      `permanently silent. Failed over to the ${MASTER_CEILING_DB} dBFS hard clip. ` +
      'Reload to restore look-ahead limiting.',
  );
  return clip;
}
