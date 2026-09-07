// packages/web/src/lib/graph/rig-relaunch-guard.ts
//
// NATIVE-SHELL PRE-FLIGHT — THE RELAUNCH BOUNCE.
//
// Owner rule (native-shell plan): force the pre-flight setup screen only on a
// FIRST RUN or when a device the operator ALREADY BOUND has gone missing. The
// shell's main process decides first-run vs configured (rig-store.ts →
// initialRoute in main.ts); THIS module is the second half — the renderer check
// that runs when `/rack` mounts and bounces back to `/preflight` when a bound
// device is no longer present:
//
//   * a bound CAMERA whose deviceId AND label are absent from enumerateDevices,
//   * a bound DISPLAY whose fingerprint no longer resolves against the live
//     screen set (screen-identity.resolveScreens), or
//   * an ES-9 / PTZ helper the rig configured that the supervisor reports down.
//
// ── SOUNDNESS: BOUNCE ONLY ON A POSITIVE ABSENCE ────────────────────────────
//
// The planner NEVER bounces on missing evidence. `enumerateDevices` before a
// permission grant returns redacted entries; `getScreenDetails()` off a user
// gesture rejects; a plain browser has no helper supervisor at all. Each of
// those is INDETERMINATE (`null`, or a redacted list), and the rule is "keep
// the rack" — a false bounce would strand the operator on /preflight for a
// device that is actually fine. A bounce fires only when the live evidence is
// real AND positively lacks the bound device. That is what keeps the guard off
// the ~hundreds of ordinary /rack e2e specs: an UNBOUND rig gathers no evidence
// (evaluateRigRelaunch short-circuits) and can never prompt or bounce.
//
// PURE planner + thin impure gatherers, the device-slots.ts convention: every
// decision is a unit test against plain fixtures; only the three enumerators
// touch the browser, each guarded so an import chain never throws.

import { describeScreen, resolveScreens, type ScreenDescriptor } from '$lib/ui/modules/screen-identity';
import {
  CAMERA_SLOT_NAMES,
  OUTPUT_SLOT_NAMES,
  type OutputSlotName,
} from './device-slots';
import type { RigBindings } from './device-slot-bindings';

/** A live camera device, from `enumerateDevices()` filtered to videoinput. */
export interface LiveVideoInput {
  deviceId: string;
  label: string;
}

/** A live display, id-tagged for a stable option key (assignScreenIds). */
export interface LiveScreen {
  id: string;
  descriptor: ScreenDescriptor;
}

/** Everything the planner reasons over. A `null` field is INDETERMINATE — the
 *  evidence could not be gathered — and the planner treats it as "keep", never
 *  as "missing". */
export interface RigPresenceEvidence {
  /** Live video inputs, or null when enumeration is unavailable. */
  videoInputs: LiveVideoInput[] | null;
  /** Live screen fingerprints, or null when the Window Management API is
   *  unavailable / not granted (no gesture on a route mount). */
  screens: ScreenDescriptor[] | null;
  /** Helper id → state (shell only), or null in a plain browser. */
  helpers: Record<string, string> | null;
}

export interface RelaunchDecision {
  /** True when a bound device is positively absent — redirect to /preflight. */
  bounce: boolean;
  /** Human-readable, semicolon-joined reasons (for a trace / the status row).
   *  null when nothing is missing. */
  reason: string | null;
}

/** Helper states that mean the helper is NOT going to answer — the supervisor
 *  is not mid-restart, it is down. `starting` / `restarting` are transient and
 *  do NOT bounce (a relaunch races the supervisor's own boot). */
const DOWN_HELPER_STATES: ReadonlySet<string> = new Set([
  'stopped',
  'crash-looped',
  'foreign-listener',
]);

/**
 * Decide whether `/rack` should bounce to `/preflight`, given the bound rig and
 * the live evidence. PURE — the caller gathers the evidence.
 */
export function planRelaunchBounce(
  bindings: RigBindings,
  ev: RigPresenceEvidence,
): RelaunchDecision {
  const reasons: string[] = [];

  // ── CAMERAS ────────────────────────────────────────────────────────────
  // A pre-permission enumerate returns entries with an empty deviceId AND
  // label (redacted); those are indeterminate, so "usable" filters them out.
  // Only when there is at least one usable entry — a real, readable device
  // list — does an unmatched binding count as absent.
  if (ev.videoInputs) {
    const usable = ev.videoInputs.filter((v) => v.deviceId !== '' || v.label !== '');
    if (usable.length > 0) {
      for (const slot of CAMERA_SLOT_NAMES) {
        const b = bindings.cameras[slot];
        if (!b) continue;
        const present = usable.some(
          (v) =>
            (b.deviceId !== '' && v.deviceId === b.deviceId) ||
            (!!b.deviceLabel && v.label === b.deviceLabel),
        );
        if (!present) {
          reasons.push(`camera ${slot} (${b.deviceLabel || b.deviceId}) is not connected`);
        }
      }
    }
  }

  // ── DISPLAYS ───────────────────────────────────────────────────────────
  // Resolution is over the SET (screen-identity.resolveScreens): each live
  // screen is claimed once, so an unresolvable saved output lands on -1.
  if (ev.screens) {
    const boundSlots = OUTPUT_SLOT_NAMES.filter((s) => bindings.outputs[s]);
    if (boundSlots.length > 0) {
      const saved = boundSlots.map((s) => bindings.outputs[s as OutputSlotName]!.screen);
      const matched = resolveScreens(saved, ev.screens);
      boundSlots.forEach((s, i) => {
        if (matched[i] === -1) {
          reasons.push(`display ${s} (${saved[i].label || 'unnamed'}) is not connected`);
        }
      });
    }
  }

  // ── HELPERS (shell only) ─────────────────────────────────────────────────
  // A helper is a "bound device" only when the operator configured its class:
  // es9 config present, or a PTZ device picked (the pt-ptz helper is what mints
  // the PT-PTZ virtual MIDI ports, so a down helper means the port is gone).
  if (ev.helpers) {
    if (bindings.es9 && isHelperDown(ev.helpers, 'es9')) {
      reasons.push(`ES-9 helper is ${ev.helpers['es9']}`);
    }
    if (bindings.ptz && isHelperDown(ev.helpers, 'ptz')) {
      reasons.push(`PTZ helper is ${ev.helpers['ptz']}`);
    }
  }

  return { bounce: reasons.length > 0, reason: reasons.length ? reasons.join('; ') : null };
}

function isHelperDown(helpers: Record<string, string>, id: string): boolean {
  const st = helpers[id];
  return st !== undefined && DOWN_HELPER_STATES.has(st);
}

// ── IMPURE EVIDENCE GATHERERS ────────────────────────────────────────────────

/** Live videoinput devices, or null when the API is absent / throws. Needs no
 *  permission — enumerateDevices is callable before a grant (labels redacted). */
export async function enumerateVideoInputs(): Promise<LiveVideoInput[] | null> {
  try {
    const md = (globalThis as unknown as { navigator?: { mediaDevices?: MediaDevices } }).navigator
      ?.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return null;
    const all = await md.enumerateDevices();
    return all
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return null;
  }
}

/** Live displays via the Window Management API, id-tagged. Returns null when the
 *  API is unavailable OR the call rejects (no gesture / permission not granted)
 *  — an indeterminate the planner treats as "keep". Never prompts on its own on
 *  a route mount: without transient activation getScreenDetails() rejects rather
 *  than showing UI. */
export async function enumerateLiveScreens(): Promise<LiveScreen[] | null> {
  try {
    const w = globalThis as unknown as {
      getScreenDetails?: () => Promise<{ screens?: unknown[] }>;
    };
    if (typeof w.getScreenDetails !== 'function') return null;
    const details = await w.getScreenDetails();
    const list = (details.screens ?? []) as Parameters<typeof describeScreen>[0][];
    const descriptors = list.map(describeScreen);
    // Lazy import of assignScreenIds to keep the id derivation next to describe.
    const { assignScreenIds } = await import('$lib/ui/modules/screen-identity');
    const ids = assignScreenIds(descriptors);
    return descriptors.map((descriptor, i) => ({ id: ids[i], descriptor }));
  } catch {
    return null;
  }
}

/** Helper id → state from the shell supervisor, or null in a plain browser. */
export async function gatherHelperStates(): Promise<Record<string, string> | null> {
  try {
    const nat = (
      globalThis as unknown as {
        ptNative?: { command?: (op: string) => Promise<unknown> };
      }
    ).ptNative;
    if (!nat || typeof nat.command !== 'function') return null;
    const res = (await nat.command('helpers.status')) as {
      ok?: boolean;
      result?: { current?: { id: string; state: string }[]; history?: { id: string; state: string }[] };
    };
    if (!res?.ok || !res.result) return null;
    const out: Record<string, string> = {};
    for (const s of res.result.history ?? []) out[s.id] = s.state;
    for (const s of res.result.current ?? []) out[s.id] = s.state; // current wins
    return out;
  } catch {
    return null;
  }
}

/**
 * Gather exactly the evidence the bound rig requires, then decide.
 *
 * ⚠ SHORT-CIRCUITS ON AN UNBOUND CLASS. Only a bound camera triggers an
 * enumerate; only a bound display triggers a getScreenDetails (which is why an
 * ordinary /rack boot never prompts for window-management); only a configured
 * es9/ptz triggers a helpers.status. An empty rig gathers nothing and returns
 * `{ bounce: false }` — the state every non-preflight e2e spec is in.
 */
export async function evaluateRigRelaunch(bindings: RigBindings): Promise<RelaunchDecision> {
  const needCameras = CAMERA_SLOT_NAMES.some((s) => bindings.cameras[s]);
  const needScreens = OUTPUT_SLOT_NAMES.some((s) => bindings.outputs[s]);
  const needHelpers = !!(bindings.es9 || bindings.ptz);
  if (!needCameras && !needScreens && !needHelpers) {
    return { bounce: false, reason: null };
  }
  const [videoInputs, screens, helpers] = await Promise.all([
    needCameras ? enumerateVideoInputs() : Promise.resolve(null),
    needScreens
      ? enumerateLiveScreens().then((ls) => (ls ? ls.map((s) => s.descriptor) : null))
      : Promise.resolve(null),
    needHelpers ? gatherHelperStates() : Promise.resolve(null),
  ]);
  return planRelaunchBounce(bindings, { videoInputs, screens, helpers });
}
