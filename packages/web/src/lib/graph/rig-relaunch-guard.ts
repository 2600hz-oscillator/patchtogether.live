// NATIVE-SHELL PRE-FLIGHT — THE RELAUNCH BOUNCE.
//
// Owner rule (native-shell plan): force the pre-flight setup screen only on a
// FIRST RUN or when a device the operator ALREADY BOUND has gone missing. The
// shell's main process opens /preflight on every launch (main.ts); THIS module
// is the second half — the renderer check that runs when `/rack` mounts and
// bounces back to `/preflight` when a bound device is no longer present:
//
//   * a bound CAMERA whose deviceId AND label are absent from enumerateDevices,
//   * a PTZ port the operator picked whose pt-ptz helper the supervisor reports
//     DOWN (the helper mints the PT-PTZ virtual MIDI ports, so a dead helper
//     means the picked port is gone).
//
// What it deliberately does NOT reason over, because nothing under the shell
// consumes the binding and a bounce would land on a splash that cannot fix it:
//
//   * DISPLAYS — `main.ts` creates no output windows and holds no display map
//     (docs/design/native-shell.md "Not built"); the rack's own present path
//     still writes `outputs` so a browser rig survives File→New, but under the
//     shell that record is applied by nobody, so it is not a "bound device".
//   * ES-9 — the es9 module connects to its bridge from the rack on its own;
//     the splash carries only the helper's status row, not a binding.
//
// ── SOUNDNESS: BOUNCE ONLY ON A POSITIVE ABSENCE ────────────────────────────
//
// The planner NEVER bounces on missing evidence. `enumerateDevices` before a
// permission grant returns redacted entries; a plain browser has no helper
// supervisor at all; a helper whose binary was never built reports
// `unavailable`. Each of those is INDETERMINATE (`null`, a redacted list, or
// the `unavailable` state), and the rule is "keep the rack" — a false bounce
// would strand the operator on /preflight for a device that is actually fine,
// and a bounce the splash cannot cure is a /preflight ↔ /rack loop. A bounce
// fires only when the live evidence is real AND positively lacks the bound
// device. That is what keeps the guard off the ~hundreds of ordinary /rack e2e
// specs: an UNBOUND rig gathers no evidence (evaluateRigRelaunch
// short-circuits) and can never prompt or bounce.
//
// ── ENTER RACK NEVER BOUNCES STRAIGHT BACK ──────────────────────────────────
//
// The splash's Enter rack arms a one-shot skip (`armRelaunchGuardSkip`, in
// sessionStorage, which survives the shell's same-window /preflight → /rack
// swap and dies with the window). The next `/rack` mount consumes it and keeps
// the rack whatever the evidence says — the operator has JUST reviewed the
// hardware. A later reload or relaunch runs the guard again.
//
// ── ⚠ NATIVE SHELL ONLY (owner ruling 2026-09-15) ───────────────────────────
//
// `/preflight` is a shell feature — there is nothing to bounce TO in a plain
// browser, where every device binds in the rack (the slot pickers, the
// audio-out picker, the CONNECT cells). The guard shipped in #2374 ran in the
// browser as well, and a camera the operator had bound FROM THE RACK that was
// absent at the next mount bounced dev to /preflight, whose "enter rack" re-ran
// the same guard on the same store and bounced straight back
// (rack/+page.svelte). Worse, the bounce tore Canvas down under the eager-boot
// reconcile pass of a restored video rack, so every remaining node and edge
// logged "no engine registered for domain" (Canvas.svelte onDestroy disposes
// the engine; engine.ts dispose() clears the domain map). So
// `evaluateRigRelaunch` is a NO-OP outside the shell: no evidence is gathered,
// no device API is touched, `{ bounce: false }` is returned. The pure planner
// below is unchanged; the shell's Tier-A harness and the shell-stubbed e2e
// still exercise the bounce.
//
// PURE planner + thin impure gatherers, the device-slots.ts convention: every
// decision is a unit test against plain fixtures; only the enumerators touch
// the browser, each guarded so an import chain never throws.

import { nativeAvailable } from '$lib/platform/native';
import { CAMERA_SLOT_NAMES } from './device-slots';
import type { RigBindings } from './device-slot-bindings';

/** A live camera device, from `enumerateDevices()` filtered to videoinput. */
export interface LiveVideoInput {
  deviceId: string;
  label: string;
}

/** Everything the planner reasons over. A `null` field is INDETERMINATE — the
 *  evidence could not be gathered — and the planner treats it as "keep", never
 *  as "missing". */
export interface RigPresenceEvidence {
  /** Live video inputs, or null when enumeration is unavailable. */
  videoInputs: LiveVideoInput[] | null;
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
 *  do NOT bounce (a relaunch races the supervisor's own boot). `unavailable`
 *  (no binary at the configured path, apps/desktop supervisor.ts) is NOT here
 *  either: a helper that was never built is indeterminate about the rig, and
 *  the splash cannot build it — bouncing on it is the loop this guard exists
 *  to avoid. */
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

  // ── PTZ HELPER (shell only) ──────────────────────────────────────────────
  // The helper is a "bound device" only when the operator picked a PT-PTZ
  // port on the splash — a positive binding with a consumer (audio/ptz-midi.ts
  // resolves the pick), never a policy string.
  if (ev.helpers && bindings.ptz && isHelperDown(ev.helpers, 'ptz')) {
    reasons.push(`PTZ helper is ${ev.helpers['ptz']}`);
  }

  return { bounce: reasons.length > 0, reason: reasons.length ? reasons.join('; ') : null };
}

function isHelperDown(helpers: Record<string, string>, id: string): boolean {
  const st = helpers[id];
  return st !== undefined && DOWN_HELPER_STATES.has(st);
}

// ── THE ONE-SHOT SKIP (Enter rack) ──────────────────────────────────────────

/** sessionStorage key: per-window, survives the shell's same-window
 *  /preflight → /rack swap and a client `goto`, never a relaunch. */
export const RELAUNCH_GUARD_SKIP_KEY = 'pt:relaunch-guard:skip-once';

function sessionStore(): Storage | null {
  try {
    return (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Arm the skip. Called by the splash's Enter rack, right before the hand-off. */
export function armRelaunchGuardSkip(): void {
  try {
    sessionStore()?.setItem(RELAUNCH_GUARD_SKIP_KEY, '1');
  } catch {
    /* private mode / partial window — the guard simply runs */
  }
}

/** Consume the skip: true exactly once per arming. */
export function consumeRelaunchGuardSkip(): boolean {
  try {
    const ss = sessionStore();
    if (!ss || ss.getItem(RELAUNCH_GUARD_SKIP_KEY) === null) return false;
    ss.removeItem(RELAUNCH_GUARD_SKIP_KEY);
    return true;
  } catch {
    return false;
  }
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
 * enumerate; only a picked PTZ port triggers a helpers.status. An empty rig
 * gathers nothing and returns `{ bounce: false }` — the state every
 * non-preflight e2e spec is in. The Enter-rack skip is consumed FIRST, on
 * every shell mount, so an armed skip can never outlive the mount it was
 * armed for.
 */
export async function evaluateRigRelaunch(bindings: RigBindings): Promise<RelaunchDecision> {
  // A plain browser has no /preflight to bounce to (see the header): keep the
  // rack, and touch no device API on the way out.
  if (!nativeAvailable()) return { bounce: false, reason: null };
  if (consumeRelaunchGuardSkip()) return { bounce: false, reason: null };
  const needCameras = CAMERA_SLOT_NAMES.some((s) => bindings.cameras[s]);
  const needHelpers = !!bindings.ptz;
  if (!needCameras && !needHelpers) {
    return { bounce: false, reason: null };
  }
  const [videoInputs, helpers] = await Promise.all([
    needCameras ? enumerateVideoInputs() : Promise.resolve(null),
    needHelpers ? gatherHelperStates() : Promise.resolve(null),
  ]);
  return planRelaunchBounce(bindings, { videoInputs, helpers });
}
