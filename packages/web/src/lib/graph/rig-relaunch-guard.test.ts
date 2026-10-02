import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  RELAUNCH_GUARD_SKIP_KEY,
  armRelaunchGuardSkip,
  consumeRelaunchGuardSkip,
  evaluateRigRelaunch,
  planRelaunchBounce,
  type RigPresenceEvidence,
} from './rig-relaunch-guard';
import { emptyRigBindings, type RigBindings } from './device-slot-bindings';
import { setNativeAvailableForTests } from '$lib/platform/native';

/** Fully-indeterminate evidence — every leg null. The planner must never bounce
 *  on this (the shape a plain browser route mount produces). */
const BLIND: RigPresenceEvidence = { videoInputs: null, helpers: null };

function rig(patch: Partial<RigBindings>): RigBindings {
  return { ...emptyRigBindings(), ...patch };
}

/** A sessionStorage double: the splash arms the skip here and the next /rack
 *  mount consumes it. */
function fakeSessionStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('planRelaunchBounce', () => {
  it('never bounces an empty rig, whatever the evidence', () => {
    expect(planRelaunchBounce(emptyRigBindings(), BLIND).bounce).toBe(false);
    expect(
      planRelaunchBounce(emptyRigBindings(), {
        videoInputs: [],
        helpers: { es9: 'stopped', ptz: 'stopped' },
      }).bounce,
    ).toBe(false);
  });

  it('never bounces on indeterminate evidence even with everything bound', () => {
    const b = rig({
      cameras: { cam1: { deviceId: 'd1', deviceLabel: 'Studio Cam' } },
      ptz: { deviceId: 'PT-PTZ-CAM1' },
    });
    expect(planRelaunchBounce(b, BLIND).bounce).toBe(false);
  });

  // ── CAMERAS ────────────────────────────────────────────────────────────
  it('keeps a bound camera present by deviceId', () => {
    const b = rig({ cameras: { cam1: { deviceId: 'd1', deviceLabel: 'Studio Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: 'd1', label: 'Studio Cam' }],
      helpers: null,
    };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  it('keeps a bound camera present by LABEL when the deviceId hash rotated', () => {
    const b = rig({ cameras: { cam1: { deviceId: 'old-hash', deviceLabel: 'Studio Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: 'new-hash', label: 'Studio Cam' }],
      helpers: null,
    };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  it('bounces when a bound camera is absent from a real device list', () => {
    const b = rig({ cameras: { cam2: { deviceId: 'gone', deviceLabel: 'Old Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: 'other', label: 'Some Other Cam' }],
      helpers: null,
    };
    const d = planRelaunchBounce(b, ev);
    expect(d.bounce).toBe(true);
    expect(d.reason).toContain('cam2');
  });

  it('does NOT bounce when the device list is only redacted entries (pre-permission)', () => {
    const b = rig({ cameras: { cam1: { deviceId: 'gone', deviceLabel: 'Old Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: '', label: '' }],
      helpers: null,
    };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  // ── DISPLAYS: NOT A BOUNCE ──────────────────────────────────────────────
  // The shell opens no output windows, so an `outputs` record (the rack's own
  // present path still writes it) is applied by nobody under the shell — a
  // write-only binding must never arm the guard, and the planner has no
  // display leg at all.
  it('a bound display is never a reason — the planner has no display leg', () => {
    const screen = { label: 'DELL U2720Q', isInternal: false, width: 3840, height: 2160, dpr: 2, left: 3024, top: 0 };
    const b = rig({ outputs: { output1: { screen } } });
    expect(planRelaunchBounce(b, BLIND)).toEqual({ bounce: false, reason: null });
    expect(planRelaunchBounce(b, { videoInputs: [{ deviceId: 'x', label: 'Other' }], helpers: { ptz: 'stopped' } }))
      .toEqual({ bounce: false, reason: null });
  });

  // ── PTZ HELPER ──────────────────────────────────────────────────────────
  it('bounces a picked PTZ port whose helper is DOWN (stopped / crash-looped / foreign-listener), never a running one', () => {
    const b = rig({ ptz: { deviceId: 'PT-PTZ-CAM1' } });
    for (const state of ['stopped', 'crash-looped', 'foreign-listener']) {
      const d = planRelaunchBounce(b, { videoInputs: null, helpers: { ptz: state } });
      expect(d.bounce, state).toBe(true);
      expect(d.reason).toContain('PTZ');
    }
    expect(planRelaunchBounce(b, { videoInputs: null, helpers: { ptz: 'running' } }).bounce).toBe(false);
    // transient restart states must not bounce (the relaunch races the boot)
    for (const state of ['starting', 'restarting']) {
      expect(planRelaunchBounce(b, { videoInputs: null, helpers: { ptz: state } }).bounce, state).toBe(false);
    }
  });

  it('⚠ a helper whose binary was never built (`unavailable`) is INDETERMINATE — keep the rack', () => {
    // The H1 lock: `binary not found` used to be reported as `stopped` and
    // bounced a configured helper to a splash that cannot build it, forever.
    const b = rig({ ptz: { deviceId: 'PT-PTZ-CAM1' } });
    expect(planRelaunchBounce(b, { videoInputs: null, helpers: { ptz: 'unavailable' } })).toEqual({
      bounce: false,
      reason: null,
    });
    // …and the same rig with the same helper truly down still bounces (the
    // positive control that keeps this from being a guard that never fires).
    expect(planRelaunchBounce(b, { videoInputs: null, helpers: { ptz: 'stopped' } }).bounce).toBe(true);
  });

  it('does not bounce a down helper the rig never picked a port for', () => {
    // ptz helper down, but no PT-PTZ port picked → not this rig's problem; and
    // the ES-9 helper is a status row with no binding, so it is never a reason.
    expect(
      planRelaunchBounce(emptyRigBindings(), { videoInputs: null, helpers: { ptz: 'stopped', es9: 'stopped' } }).bounce,
    ).toBe(false);
    const camOnly = rig({ cameras: { cam1: { deviceId: 'd1', deviceLabel: 'Studio Cam' } } });
    expect(
      planRelaunchBounce(camOnly, {
        videoInputs: [{ deviceId: 'd1', label: 'Studio Cam' }],
        helpers: { es9: 'crash-looped', ptz: 'crash-looped' },
      }).bounce,
    ).toBe(false);
  });

  it('joins multiple absence reasons', () => {
    const b = rig({
      cameras: { cam1: { deviceId: 'gone', deviceLabel: 'Old Cam' } },
      ptz: { deviceId: 'PT-PTZ-CAM1' },
    });
    const d = planRelaunchBounce(b, {
      videoInputs: [{ deviceId: 'x', label: 'Other' }],
      helpers: { ptz: 'crash-looped' },
    });
    expect(d.bounce).toBe(true);
    expect(d.reason).toContain('cam1');
    expect(d.reason).toContain('PTZ');
  });
});

// ── THE GUARD IS A NATIVE-SHELL FEATURE (owner ruling 2026-09-15) ────────────
//
// `evaluateRigRelaunch` is the impure wrapper the /rack route calls. In a plain
// browser it must be a NO-OP — return "keep" AND gather no evidence, because a
// browser has no /preflight to bounce to and every device binds in the rack.
// Both legs are instrumented: the negative control proves the device APIs are
// never touched on the web; the positive control proves the SAME rig, under the
// shell, still gathers and still bounces — so a green here is not a guard that
// stopped working everywhere.
describe('evaluateRigRelaunch — shell-only', () => {
  const STALE = (): RigBindings =>
    rig({
      cameras: { cam1: { deviceId: 'gone', deviceLabel: 'Old Cam' } },
      ptz: { deviceId: 'PT-PTZ-CAM1' },
    });
  const helpersReply = (ptzState: string) =>
    vi.fn(async () => ({ ok: true, result: { current: [{ id: 'ptz', state: ptzState }], history: [] } }));

  afterEach(() => {
    setNativeAvailableForTests(null);
    vi.unstubAllGlobals();
  });

  it('NEGATIVE CONTROL — in a plain browser a fully bound, fully ABSENT rig keeps the rack and touches no device API', async () => {
    setNativeAvailableForTests(false);
    const enumerateDevices = vi.fn(async () => [{ kind: 'videoinput', deviceId: 'other', label: 'Other Cam' }]);
    const command = helpersReply('stopped');
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } });
    vi.stubGlobal('ptNative', { command });

    const d = await evaluateRigRelaunch(STALE());
    expect(d).toEqual({ bounce: false, reason: null });
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — under the shell the same rig gathers every leg and bounces on the absences', async () => {
    setNativeAvailableForTests(true);
    const enumerateDevices = vi.fn(async () => [{ kind: 'videoinput', deviceId: 'other', label: 'Other Cam' }]);
    const command = helpersReply('stopped');
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } });
    vi.stubGlobal('ptNative', { command });

    const d = await evaluateRigRelaunch(STALE());
    expect(d.bounce).toBe(true);
    expect(d.reason).toContain('cam1');
    expect(d.reason).toContain('PTZ');
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('helpers.status');
  });

  it('under the shell an UNBOUND rig still short-circuits (no prompt on an ordinary mount)', async () => {
    setNativeAvailableForTests(true);
    const enumerateDevices = vi.fn(async () => []);
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } });
    expect(await evaluateRigRelaunch(emptyRigBindings())).toEqual({ bounce: false, reason: null });
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it('under the shell a picked PTZ port whose helper binary is MISSING keeps the rack (the H1 lock)', async () => {
    setNativeAvailableForTests(true);
    const command = helpersReply('unavailable');
    vi.stubGlobal('ptNative', { command });
    const d = await evaluateRigRelaunch(rig({ ptz: { deviceId: 'PT-PTZ-CAM1' } }));
    expect(d).toEqual({ bounce: false, reason: null });
    expect(command, 'the evidence WAS gathered — this is a verdict, not a short-circuit').toHaveBeenCalledWith('helpers.status');
  });

  // ── THE ONE-SHOT SKIP: Enter rack never bounces straight back ───────────
  it('an armed skip keeps the rack ONCE under the shell, gathers nothing, and the next mount runs the guard again', async () => {
    setNativeAvailableForTests(true);
    const ss = fakeSessionStorage();
    vi.stubGlobal('sessionStorage', ss);
    const enumerateDevices = vi.fn(async () => [{ kind: 'videoinput', deviceId: 'other', label: 'Other Cam' }]);
    const command = helpersReply('stopped');
    vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices } });
    vi.stubGlobal('ptNative', { command });

    armRelaunchGuardSkip();
    expect(ss.map.get(RELAUNCH_GUARD_SKIP_KEY)).toBe('1');

    // The mount right after Enter rack: keep, consume, touch nothing.
    expect(await evaluateRigRelaunch(STALE())).toEqual({ bounce: false, reason: null });
    expect(ss.map.has(RELAUNCH_GUARD_SKIP_KEY), 'consumed').toBe(false);
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();

    // A later reload / relaunch of the same stale rig: the guard is back.
    const again = await evaluateRigRelaunch(STALE());
    expect(again.bounce).toBe(true);
    expect(enumerateDevices).toHaveBeenCalledTimes(1);
  });

  it('the skip is consumed on EVERY shell mount, even an unbound one, so it cannot outlive its mount', async () => {
    setNativeAvailableForTests(true);
    const ss = fakeSessionStorage();
    vi.stubGlobal('sessionStorage', ss);
    armRelaunchGuardSkip();
    await evaluateRigRelaunch(emptyRigBindings());
    expect(ss.map.has(RELAUNCH_GUARD_SKIP_KEY)).toBe(false);
    expect(consumeRelaunchGuardSkip()).toBe(false);
  });

  it('in a plain browser the skip is irrelevant (never consumed, never needed)', async () => {
    setNativeAvailableForTests(false);
    const ss = fakeSessionStorage();
    vi.stubGlobal('sessionStorage', ss);
    armRelaunchGuardSkip();
    expect(await evaluateRigRelaunch(STALE())).toEqual({ bounce: false, reason: null });
    expect(ss.map.has(RELAUNCH_GUARD_SKIP_KEY), 'the browser branch returns before the skip').toBe(true);
  });

  it('a throwing or absent sessionStorage never arms, never consumes, never throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => armRelaunchGuardSkip()).not.toThrow();
    expect(consumeRelaunchGuardSkip()).toBe(false);
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => armRelaunchGuardSkip()).not.toThrow();
    expect(consumeRelaunchGuardSkip()).toBe(false);
  });
});
