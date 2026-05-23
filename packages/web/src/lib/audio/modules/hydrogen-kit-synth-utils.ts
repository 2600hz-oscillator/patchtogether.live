// packages/web/src/lib/audio/modules/hydrogen-kit-synth-utils.ts
//
// Common Web Audio primitives shared by HYDROGEN's synthesized kits
// (TR-909-style, FM-PERC, 8BIT). Each helper builds a small voice
// (a couple of oscillators / a noise buffer + a per-voice gain
// envelope), connects through the caller-supplied user filter, and
// returns a SynthVoice with a stop() + ended Promise for choke + GC.
//
// These primitives are intentionally narrow — each kit's drum/snare/hat
// is composed from one or two of these calls so the kit files stay
// readable. None of them allocate AudioBuffers per-voice; the only
// allocation per trigger is the small handful of Web Audio nodes that
// gc() reclaims after `ended` fires.

import type { SynthVoice, VoiceOpts } from './hydrogen-kit-types';

// ---------- shared noise buffer cache ----------
//
// Single white-noise buffer per AudioContext (1 second of mono noise),
// shared across all noise-based voices. Reused via BufferSource so we
// don't allocate a new buffer per trigger.

const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (buf) return buf;
  buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

// ---------- user-filter wrapper ----------
//
// Every voice runs through a per-voice BiquadFilter so the user's
// Cutoff/Q knobs (which exist for every instrument regardless of kit
// type) bite. The filter type is fixed lowpass — same as the sample
// path in hydrogen.ts.

function makeUserFilter(ctx: AudioContext, opts: VoiceOpts): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = opts.cutoffHz;
  f.Q.value = opts.q;
  return f;
}

// ---------- amp-envelope helper ----------
//
// Builds an attack→decay→release envelope on a fresh GainNode.
// totalDurS = the synth's natural tail length; the release ramp starts
// at totalDurS - releaseS so the envelope is fully closed by totalDurS.

function applyAmpEnv(
  ctx: AudioContext,
  env: GainNode,
  atTime: number,
  totalDurS: number,
  opts: VoiceOpts,
): void {
  const peak = opts.velocity;
  const sustainV = opts.sustain * peak;
  const A = Math.max(0.001, opts.attackS);
  const D = Math.max(0.001, opts.decayS);
  const R = Math.max(0.005, opts.releaseS);
  env.gain.setValueAtTime(0, atTime);
  env.gain.linearRampToValueAtTime(peak, atTime + A);
  env.gain.linearRampToValueAtTime(sustainV, atTime + A + D);
  const releaseStart = Math.max(atTime + A + D, atTime + totalDurS - R);
  env.gain.setValueAtTime(sustainV, releaseStart);
  env.gain.linearRampToValueAtTime(0, releaseStart + R);
}

// ---------- voice teardown helper ----------
//
// Wraps the "stop me at atTime + ramp to 0 + disconnect" boilerplate.
// Returns a SynthVoice with stop() (callable multiple times — only the
// first call schedules teardown) and an `ended` Promise resolved after
// teardownAtSec elapses.

function makeVoiceHandle(
  ctx: AudioContext,
  cleanup: () => void,
  startedAt: number,
  totalDurS: number,
): SynthVoice {
  let stopped = false;
  let resolveEnded: (() => void) | null = null;
  const ended = new Promise<void>((r) => { resolveEnded = r; });
  const naturalEnd = startedAt + totalDurS + 0.05;
  function scheduleEnd(at: number) {
    const ms = Math.max(0, (at - ctx.currentTime)) * 1000;
    setTimeout(() => {
      cleanup();
      resolveEnded?.();
    }, ms);
  }
  scheduleEnd(naturalEnd);
  return {
    stop(atTime: number) {
      if (stopped) return;
      stopped = true;
      const fastEnd = Math.max(ctx.currentTime, atTime) + 0.02;
      // We can't preempt the natural-end setTimeout, but cleanup() is
      // idempotent on the underlying nodes (disconnect-on-disconnected
      // throws which we swallow); calling scheduleEnd again just
      // shortens the wait.
      scheduleEnd(fastEnd);
    },
    ended,
  };
}

// ----------------------------------------------------------------------
// Voice primitives — each returns a SynthVoice connected to `dest`.
// ----------------------------------------------------------------------

/** Sine pitch-sweep — start at startHz, exp-ramp to endHz over sweepS.
 *  Classic kick/tom shape. */
export function sineSweepVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { startHz: number; endHz: number; sweepS: number; tailS: number; pitchScale?: number },
): SynthVoice {
  const pitchMul = Math.pow(2, opts.pitchSt / 12) * (cfg.pitchScale ?? 1);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(cfg.startHz * pitchMul, atTime);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(0.01, cfg.endHz * pitchMul),
    atTime + Math.max(0.005, cfg.sweepS),
  );

  const filter = makeUserFilter(ctx, opts);
  const env = ctx.createGain();
  osc.connect(filter);
  filter.connect(env);
  env.connect(dest);

  const totalDur = cfg.tailS;
  applyAmpEnv(ctx, env, atTime, totalDur, opts);
  osc.start(atTime);
  osc.stop(atTime + totalDur + 0.05);

  return makeVoiceHandle(ctx, () => {
    try { osc.disconnect(); filter.disconnect(); env.disconnect(); } catch { /* */ }
  }, atTime, totalDur);
}

/** Triangle/square pitch-sweep — same as sineSweepVoice but with a
 *  chiptune-style waveform. */
export function pulseSweepVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { wave: OscillatorType; startHz: number; endHz: number; sweepS: number; tailS: number; pitchScale?: number },
): SynthVoice {
  const pitchMul = Math.pow(2, opts.pitchSt / 12) * (cfg.pitchScale ?? 1);
  const osc = ctx.createOscillator();
  osc.type = cfg.wave;
  osc.frequency.setValueAtTime(cfg.startHz * pitchMul, atTime);
  if (Math.abs(cfg.endHz - cfg.startHz) > 0.5) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(0.01, cfg.endHz * pitchMul),
      atTime + Math.max(0.005, cfg.sweepS),
    );
  }

  const filter = makeUserFilter(ctx, opts);
  const env = ctx.createGain();
  osc.connect(filter);
  filter.connect(env);
  env.connect(dest);

  const totalDur = cfg.tailS;
  applyAmpEnv(ctx, env, atTime, totalDur, opts);
  osc.start(atTime);
  osc.stop(atTime + totalDur + 0.05);

  return makeVoiceHandle(ctx, () => {
    try { osc.disconnect(); filter.disconnect(); env.disconnect(); } catch { /* */ }
  }, atTime, totalDur);
}

/** Filtered-noise burst — snare/hat/clap building block. The bandpass
 *  highHz lifts content above the lowpass cutoff (e.g. 6 kHz for hats,
 *  300 Hz for snares); tailS sets the natural decay. */
export function noiseBurstVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { highHz: number; tailS: number; q?: number; gain?: number },
): SynthVoice {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  src.loop = true;

  // Bandpass-style: high-pass to remove low rumble + the user lowpass
  // afterward forms a band-pass between [highHz, opts.cutoffHz].
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = cfg.highHz;
  hp.Q.value = cfg.q ?? 0.7;

  const filter = makeUserFilter(ctx, opts);
  const pre = ctx.createGain();
  pre.gain.value = cfg.gain ?? 0.6;
  const env = ctx.createGain();

  src.connect(hp);
  hp.connect(filter);
  filter.connect(pre);
  pre.connect(env);
  env.connect(dest);

  const totalDur = cfg.tailS;
  applyAmpEnv(ctx, env, atTime, totalDur, opts);
  src.start(atTime);
  src.stop(atTime + totalDur + 0.05);

  return makeVoiceHandle(ctx, () => {
    try { src.disconnect(); hp.disconnect(); filter.disconnect(); pre.disconnect(); env.disconnect(); } catch { /* */ }
  }, atTime, totalDur);
}

/** Snare-style: sine body + filtered noise blend. Body gives the
 *  pitched thump, noise gives the rattle. */
export function snareVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { bodyHz: number; bodyS: number; noiseHighHz: number; noiseS: number; noiseGain?: number },
): SynthVoice {
  const pitchMul = Math.pow(2, opts.pitchSt / 12);
  // Body: triangle for clarity, no sweep.
  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(cfg.bodyHz * pitchMul, atTime);
  body.frequency.exponentialRampToValueAtTime(
    Math.max(20, cfg.bodyHz * pitchMul * 0.5), atTime + cfg.bodyS,
  );

  const bodyEnv = ctx.createGain();
  bodyEnv.gain.setValueAtTime(opts.velocity * 0.7, atTime);
  bodyEnv.gain.exponentialRampToValueAtTime(0.0001, atTime + cfg.bodyS);
  body.connect(bodyEnv);

  // Noise tail.
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  noise.loop = true;
  const noiseHp = ctx.createBiquadFilter();
  noiseHp.type = 'highpass';
  noiseHp.frequency.value = cfg.noiseHighHz;
  const noiseEnv = ctx.createGain();
  noiseEnv.gain.setValueAtTime(opts.velocity * (cfg.noiseGain ?? 0.5), atTime);
  noiseEnv.gain.exponentialRampToValueAtTime(0.0001, atTime + cfg.noiseS);
  noise.connect(noiseHp);
  noiseHp.connect(noiseEnv);

  // Mix → user filter → output env (ADSR shape).
  const mix = ctx.createGain();
  bodyEnv.connect(mix);
  noiseEnv.connect(mix);
  const filter = makeUserFilter(ctx, opts);
  const out = ctx.createGain();
  mix.connect(filter);
  filter.connect(out);
  out.connect(dest);

  const totalDur = Math.max(cfg.bodyS, cfg.noiseS);
  applyAmpEnv(ctx, out, atTime, totalDur, opts);

  body.start(atTime);
  body.stop(atTime + totalDur + 0.05);
  noise.start(atTime);
  noise.stop(atTime + totalDur + 0.05);

  return makeVoiceHandle(ctx, () => {
    try {
      body.disconnect(); bodyEnv.disconnect();
      noise.disconnect(); noiseHp.disconnect(); noiseEnv.disconnect();
      mix.disconnect(); filter.disconnect(); out.disconnect();
    } catch { /* */ }
  }, atTime, totalDur);
}

/** Clap-style: 4 fast noise bursts spaced 8ms apart, then a longer tail.
 *  Faithful to the TR-808/909 clap circuit's burst→tail amplitude
 *  envelope. */
export function clapVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { burstHz: number; burstS: number; tailS: number },
): SynthVoice {
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  noise.loop = true;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = cfg.burstHz;
  bp.Q.value = 1.4;

  const filter = makeUserFilter(ctx, opts);
  const burstEnv = ctx.createGain();
  burstEnv.gain.setValueAtTime(0, atTime);
  // 4 bursts at 0, 8, 16, 24 ms.
  const burstPeak = opts.velocity * 0.9;
  for (let i = 0; i < 4; i++) {
    const t = atTime + i * 0.008;
    burstEnv.gain.linearRampToValueAtTime(burstPeak, t);
    burstEnv.gain.exponentialRampToValueAtTime(0.001, t + cfg.burstS);
  }
  // Long tail after the bursts.
  const tailStart = atTime + 0.032;
  burstEnv.gain.linearRampToValueAtTime(opts.velocity * 0.3, tailStart);
  burstEnv.gain.exponentialRampToValueAtTime(0.0001, tailStart + cfg.tailS);

  const out = ctx.createGain();
  noise.connect(bp);
  bp.connect(filter);
  filter.connect(burstEnv);
  burstEnv.connect(out);
  out.connect(dest);

  const totalDur = 0.032 + cfg.tailS;
  applyAmpEnv(ctx, out, atTime, totalDur, opts);
  noise.start(atTime);
  noise.stop(atTime + totalDur + 0.05);

  return makeVoiceHandle(ctx, () => {
    try { noise.disconnect(); bp.disconnect(); filter.disconnect(); burstEnv.disconnect(); out.disconnect(); } catch { /* */ }
  }, atTime, totalDur);
}

/** 2-op FM voice: carrier + modulator (sine waves). The modulator
 *  feeds the carrier's frequency AudioParam at `modIndex` Hz of
 *  deviation. Classic FM bell / metallic perc shape. */
export function fmVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { carrierHz: number; modRatio: number; modIndex: number; tailS: number; sweepEndHz?: number },
): SynthVoice {
  const pitchMul = Math.pow(2, opts.pitchSt / 12);
  const carrierHz = cfg.carrierHz * pitchMul;
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(carrierHz, atTime);
  if (cfg.sweepEndHz !== undefined) {
    carrier.frequency.exponentialRampToValueAtTime(
      Math.max(20, cfg.sweepEndHz * pitchMul),
      atTime + Math.max(0.01, cfg.tailS * 0.4),
    );
  }

  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.setValueAtTime(carrierHz * cfg.modRatio, atTime);
  if (cfg.sweepEndHz !== undefined) {
    mod.frequency.exponentialRampToValueAtTime(
      Math.max(20, cfg.sweepEndHz * pitchMul * cfg.modRatio),
      atTime + Math.max(0.01, cfg.tailS * 0.4),
    );
  }

  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(cfg.modIndex, atTime);
  // Modulator amplitude decays through the tail — gives FM the
  // characteristic "spectrum-narrows-over-time" perc envelope.
  modGain.gain.exponentialRampToValueAtTime(0.001, atTime + cfg.tailS);

  mod.connect(modGain);
  modGain.connect(carrier.frequency);

  const filter = makeUserFilter(ctx, opts);
  const env = ctx.createGain();
  carrier.connect(filter);
  filter.connect(env);
  env.connect(dest);

  applyAmpEnv(ctx, env, atTime, cfg.tailS, opts);
  carrier.start(atTime);
  carrier.stop(atTime + cfg.tailS + 0.05);
  mod.start(atTime);
  mod.stop(atTime + cfg.tailS + 0.05);

  return makeVoiceHandle(ctx, () => {
    try {
      carrier.disconnect(); mod.disconnect(); modGain.disconnect();
      filter.disconnect(); env.disconnect();
    } catch { /* */ }
  }, atTime, cfg.tailS);
}

/** Twin-square cowbell — the classic 800/540 Hz square-wave duet
 *  that defines the 808 cowbell tone. Pitched up + tail-shortened it
 *  also serves as the 909-style cowbell. */
export function cowbellVoice(
  ctx: AudioContext, dest: AudioNode, atTime: number, opts: VoiceOpts,
  cfg: { topHz: number; bottomHz: number; tailS: number },
): SynthVoice {
  const pitchMul = Math.pow(2, opts.pitchSt / 12);
  const o1 = ctx.createOscillator();
  o1.type = 'square';
  o1.frequency.value = cfg.topHz * pitchMul;
  const o2 = ctx.createOscillator();
  o2.type = 'square';
  o2.frequency.value = cfg.bottomHz * pitchMul;

  const mix = ctx.createGain();
  mix.gain.value = 0.18;
  o1.connect(mix);
  o2.connect(mix);

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = cfg.topHz * pitchMul;
  bp.Q.value = 2;

  const filter = makeUserFilter(ctx, opts);
  const env = ctx.createGain();
  mix.connect(bp);
  bp.connect(filter);
  filter.connect(env);
  env.connect(dest);

  applyAmpEnv(ctx, env, atTime, cfg.tailS, opts);
  o1.start(atTime);
  o1.stop(atTime + cfg.tailS + 0.05);
  o2.start(atTime);
  o2.stop(atTime + cfg.tailS + 0.05);

  return makeVoiceHandle(ctx, () => {
    try { o1.disconnect(); o2.disconnect(); mix.disconnect(); bp.disconnect(); filter.disconnect(); env.disconnect(); } catch { /* */ }
  }, atTime, cfg.tailS);
}
