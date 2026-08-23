// packages/web/src/lib/ui/modules/treeohvox-face-model.ts
//
// The PURE model behind the TREE.oh.VOX faceplate — the three frequencies a
// TB-303 actually sweeps between, none of which is the number on its CUTOFF
// knob.
//
// ── WHY IT EXISTS ──────────────────────────────────────────────────────────
//
// The voice modulates its ladder cutoff per sample
// (`TreeohvoxVoice.updateFilter`, `treeohvox-dsp.ts:733-744`):
//
//     map        = envModScalerOffset(cutoffHz, envAmount01 * 100)
//     cutoffMod  = map.scaler * (env - map.offset) + accentGain * env
//     instCutoff = clamp(cutoffHz * 2^cutoffMod, 40, 20000)
//
// `env` is the decay envelope, which `trigger()` resets to exactly 1.0
// (`TbVoxDecayEnv:283`), so it spans [0,1] over a note. `(scaler, offset)` come
// from `envModScalerOffset` — a verbatim port of Robin Schmidt's hardware
// measurements (`rosic::Open303::calculateEnvModScalerAndOffset`).
//
// ⚠ THE CONSEQUENCE, MEASURED AT THE DEF'S OWN DEFAULTS (cutoff 1000 Hz,
// envelope 0.5, accent 0.5 — scaler 2.816537, offset 0.321934):
//
//     the CUTOFF dial says      1000 Hz
//     the filter rests at        533.4 Hz     (env = 0)
//     the filter peaks at       3757.6 Hz     (env = 1)
//     an ACCENTED note peaks at 5314.0 Hz
//
// The knob's number is a frequency the filter is NEVER AT, except in passing
// while the envelope crosses `offset`. That is the kickdrum-TAIL trap in its
// purest form, and it is why these are derived values rather than a relabelled
// `cutoff`.
//
// THE NEGATIVE CONTROL A `cutoff` READBACK FAILS — hold CUTOFF at 1000 and
// sweep ENVELOPE, which the dial cannot see at all:
//
//     envelope 0.00   rest 834.7   peak 1463.0
//     envelope 0.25   rest 667.3   peak 2344.7
//     envelope 0.50   rest 533.4   peak 3757.6
//     envelope 0.75   rest 426.4   peak 6021.9
//     envelope 1.00   rest 340.8   peak 9650.6
//
// 6.6× on the peak — and REST MOVES THE OPPOSITE WAY over the same sweep,
// which is the property proving these are two numbers rather than one number
// twice. Both directions are permanent in `treeohvox-face-model.test.ts`.
//
// PURE: no DOM, no engine, no store, no fs, no sample rate. (`instCutoff` is
// sample-rate free — `envModScalerOffset` and the 2^x law both are; only the
// filter COEFFICIENTS downstream need `sr`.)

import { treeohvoxDef } from '$lib/audio/modules/treeohvox';
import {
  envModScalerOffset,
  TB303_CUTOFF_FLOOR_HZ,
} from '../../../../../dsp/src/lib/treeohvox-dsp';

// RELATIVE path, not the `@patchtogether.live/dsp/src/...` alias, for the reason
// `moogcp3-face-model.ts`, `moog921-face-model.ts` and `ninelives-face-model.ts`
// all document: a worktree may not symlink the workspace package under
// node_modules, and the TS path-alias rules do not reliably resolve TS source
// out of there.

/** The ceiling `updateFilter` clamps `instCutoff` to. NOT the def's 6000 Hz knob
 *  max — the knob bounds where the SWEEP STARTS; the swept value runs far above
 *  it and is clamped by the FILTER (`treeohvox-dsp.ts:744`). Re-typed nowhere
 *  else; the floor is imported. */
const TB303_INST_CEILING_HZ = 20000;

/** The four params the three readouts are a function of. */
export interface TreeohvoxFaceParams {
  cutoff: number;
  envelope: number;
  accent: number;
}

const IDS = ['cutoff', 'envelope', 'accent'] as const;

function paramDef(id: (typeof IDS)[number]) {
  const p = treeohvoxDef.params.find((q) => q.id === id);
  if (!p) throw new Error(`treeohvox-face-model: no param '${id}' on treeohvoxDef`);
  return p;
}

/** Read the three params off a live reader, each CLAMPED to its declared
 *  travel and falling back to its declared default when absent or non-finite.
 *
 *  ⚠ The clamp is the `moog993RouteState` seam: MIDI learn, automation and a
 *  preset load all reach the param store with arbitrary floats, and an
 *  out-of-contract `cutoff` would put a nonsense frequency on the faceplate. */
export function treeohvoxFaceParams(
  read: (paramId: string) => number | undefined,
): TreeohvoxFaceParams {
  const one = (id: (typeof IDS)[number]): number => {
    const p = paramDef(id);
    const v = read(id);
    if (typeof v !== 'number' || !Number.isFinite(v)) return p.defaultValue;
    return v < p.min ? p.min : v > p.max ? p.max : v;
  };
  return { cutoff: one('cutoff'), envelope: one('envelope'), accent: one('accent') };
}

/**
 * THE INSTANTANEOUS FILTER CUTOFF (Hz) at a given envelope value and accent
 * gain — the voice's own law, not an approximation of it.
 *
 * `env` is the decay envelope in [0,1]; `accentGain` is `accentAmount01` on an
 * accented note and 0 otherwise (`TreeohvoxVoice.trigger`).
 */
export function treeohvoxInstCutoffHz(
  p: TreeohvoxFaceParams,
  env: number,
  accentGain: number,
): number {
  const map = envModScalerOffset(p.cutoff, p.envelope * 100);
  const mod = map.scaler * (env - map.offset) + accentGain * env;
  const hz = p.cutoff * Math.pow(2, mod);
  if (!Number.isFinite(hz)) return TB303_CUTOFF_FLOOR_HZ;
  return hz < TB303_CUTOFF_FLOOR_HZ
    ? TB303_CUTOFF_FLOOR_HZ
    : hz > TB303_INST_CEILING_HZ
      ? TB303_INST_CEILING_HZ
      : hz;
}

/** Where the filter SETTLES once the decay envelope has fallen (env = 0). */
export function treeohvoxRestHz(p: TreeohvoxFaceParams): number {
  return treeohvoxInstCutoffHz(p, 0, 0);
}

/** The TOP of the sweep on a plain note (env = 1, un-accented). */
export function treeohvoxPeakHz(p: TreeohvoxFaceParams): number {
  return treeohvoxInstCutoffHz(p, 1, 0);
}

/** The TOP of the sweep on an ACCENTED note (env = 1, accentGain = ACCENT).
 *
 *  ⚠ Reachable ONLY with a cable on `accent_in`. The module's own audition pad
 *  drives `gate_in` alone (`treeohvox.ts:220`), deliberately, so an auditioned
 *  note is never accented — which is exactly why this number is worth printing:
 *  nothing else on the surface says what ACCENT is worth. */
export function treeohvoxAccentPeakHz(p: TreeohvoxFaceParams): number {
  return treeohvoxInstCutoffHz(p, 1, p.accent);
}

/** Hz, formatted the way the rest of the faceplates do it: kHz above 1000 so a
 *  four-digit frequency does not out-width the cell. */
function fmtSweepHz(hz: number): string {
  if (!Number.isFinite(hz)) return '—';
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

export function treeohvoxRestText(read: (paramId: string) => number | undefined): string {
  return fmtSweepHz(treeohvoxRestHz(treeohvoxFaceParams(read)));
}

export function treeohvoxPeakText(read: (paramId: string) => number | undefined): string {
  return fmtSweepHz(treeohvoxPeakHz(treeohvoxFaceParams(read)));
}

export function treeohvoxAccentPeakText(read: (paramId: string) => number | undefined): string {
  return fmtSweepHz(treeohvoxAccentPeakHz(treeohvoxFaceParams(read)));
}
