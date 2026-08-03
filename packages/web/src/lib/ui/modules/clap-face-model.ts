// packages/web/src/lib/ui/modules/clap-face-model.ts
//
// THE PURE MODEL BEHIND CLAP's FACEPLATE — every number the faceplate prints or
// draws, derived here and nowhere else, through the WORKLET'S OWN control laws
// (`clapSpreadMs` / `clapPulseCount` / `clapTailMs` / `clapToneHz` /
// `clapWidthQ`), imported by RELATIVE path exactly as kickdrum-face-model
// imports its core.
//
// ⚠ CV IS STRUCTURALLY INVISIBLE HERE, and it is stated rather than hidden.
// clap's CV jacks are separate worklet NODE INPUTS, not AudioParam connections,
// so no host-side reader can see them: `readParam` returns the knob. Every law
// below is therefore evaluated at cv = 0 — the effective SPREAD under a +1 V
// spread_cv is 24.6 ms, and this model prints 10.
//
// PURE — no DOM, no Svelte, no engine. Node-testable.

import {
  clapPulseCount,
  clapSpreadMs,
  clapTailMs,
  clapToneHz,
  clapWidthQ,
} from '../../../../../dsp/src/lib/clap-dsp';
import { clapDef } from '$lib/audio/modules/clap';

/** The six params the faceplate's graph + readouts read, by DEF param id. */
export interface ClapVoiceParams {
  pulses: number;
  spread: number;
  tone: number;
  width: number;
  tail: number;
  snap: number;
}

/** The six ids, so a rename fails a test rather than silently defaulting. */
export const CLAP_VOICE_PARAM_IDS = [
  'pulses', 'spread', 'tone', 'width', 'tail', 'snap',
] as const satisfies readonly (keyof ClapVoiceParams)[];

/** Live values in, resolving the DEF DEFAULT for any param the node has not
 *  stored (node.params is a sparse overlay of what has been TOUCHED). */
export function clapVoiceParams(
  read: (paramId: string) => number | undefined,
): ClapVoiceParams {
  const val = (id: string): number => {
    const v = read(id);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const pd = clapDef.params.find((p) => p.id === id);
    if (!pd) throw new Error(`clap-face-model: clap has no param '${id}'`);
    return pd.defaultValue;
  };
  return {
    pulses: val('pulses'),
    spread: val('spread'),
    tone: val('tone'),
    width: val('width'),
    tail: val('tail'),
    snap: val('snap'),
  };
}

/** −60 dB length of the BURST TRAIN. Pulse k fires at k·S and the FINAL pulse
 *  decays over 2·S (FINAL_PULSE_RATIO), so the last onset at (N−1)·S ends
 *  2·S later: (N+1)·S. */
export function clapBurstMs(p: ClapVoiceParams): number {
  return (clapPulseCount(p.pulses) + 1) * clapSpreadMs(p.spread, 0);
}

/** When the ROOM fires — at the LAST onset, (N−1)·S after the strike. The
 *  pre-delay no control on the panel is named after. */
export function clapRoomOnsetMs(p: ClapVoiceParams): number {
  return (clapPulseCount(p.pulses) - 1) * clapSpreadMs(p.spread, 0);
}

/** The whole voice's −60 dB length: the LONGER of the two branches SNAP
 *  actually lets through. NOT `tail` — a `paramId: 'tail'` readout prints
 *  150 ms at SNAP 0.5 AND at SNAP 1, where the room is gone entirely and the
 *  voice is 40 ms long. */
export function clapVoiceMs(p: ClapVoiceParams): number {
  const burst = p.snap > 0 ? clapBurstMs(p) : 0;
  const room = p.snap < 1 ? clapRoomOnsetMs(p) + clapTailMs(p.tail, 0) : 0;
  return Math.max(burst, room);
}

/** Band-pass −3 dB bandwidth (Hz): BW = fc · q, q = the Chamberlin coefficient
 *  (1/Q). Moves with TONE and with WIDTH. */
export function clapBandwidthHz(p: ClapVoiceParams): number {
  return clapToneHz(p.tone, 0) * clapWidthQ(p.width);
}

/** Band-pass Q = 1/q. A function of WIDTH ALONE — TONE-invariant by
 *  construction, which is what makes publishing it next to the bandwidth a
 *  negative control on both. */
export function clapQ(p: ClapVoiceParams): number {
  return 1 / clapWidthQ(p.width);
}

// ── the hero picture's geometry ─────────────────────────────────────────────

/** One point of a plotted envelope, x in 0..1 of the window, y in 0..1. */
export interface ClapGraphPoint {
  x: number;
  burst: number;
  room: number;
}

export interface ClapGraph {
  points: readonly ClapGraphPoint[];
  /** Where the ROOM fires, as a fraction of the window (or null past it). */
  roomX: number | null;
  /** The voice's −60 dB length, as a fraction of the window (or null). */
  voiceX: number | null;
}

/** The equal-power crossfade weights the DSP applies to the two branches. */
export function clapBurstGain(p: ClapVoiceParams): number {
  return Math.sqrt(Math.max(0, Math.min(1, p.snap)));
}
export function clapRoomGain(p: ClapVoiceParams): number {
  return Math.sqrt(1 - Math.max(0, Math.min(1, p.snap)));
}

/** Burst envelope at t ms — the max over the N pulses, each an exponential to
 *  −60 dB over its own spacing (the final pulse over twice that). */
function burstAt(p: ClapVoiceParams, tMs: number): number {
  const n = clapPulseCount(p.pulses);
  const s = clapSpreadMs(p.spread, 0);
  let best = 0;
  for (let k = 0; k < n; k++) {
    const t0 = k * s;
    if (tMs < t0) continue;
    const len = s * (k === n - 1 ? 2 : 1);
    // exp decay reaching −60 dB (1e-3) at `len`.
    const v = Math.exp((-6.907755278982137 * (tMs - t0)) / len);
    if (v > best) best = v;
  }
  return best;
}

/** Room envelope at t ms — fires at the LAST onset, decays over TAIL. */
function roomAt(p: ClapVoiceParams, tMs: number): number {
  const t0 = clapRoomOnsetMs(p);
  if (tMs < t0) return 0;
  const len = clapTailMs(p.tail, 0);
  return Math.exp((-6.907755278982137 * (tMs - t0)) / len);
}

/** The two envelopes over `windowMs`, already scaled by the equal-power
 *  crossfade so the picture shows the balance you are actually hearing. */
export function clapGraph(p: ClapVoiceParams, windowMs: number, n = 220): ClapGraph {
  const bg = clapBurstGain(p);
  const rg = clapRoomGain(p);
  const points: ClapGraphPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const t = x * windowMs;
    points.push({ x, burst: burstAt(p, t) * bg, room: roomAt(p, t) * rg });
  }
  const roomOn = clapRoomOnsetMs(p);
  const voice = clapVoiceMs(p);
  return {
    points,
    roomX: rg > 0 && roomOn <= windowMs ? roomOn / windowMs : null,
    voiceX: voice > 0 && voice <= windowMs ? voice / windowMs : null,
  };
}
