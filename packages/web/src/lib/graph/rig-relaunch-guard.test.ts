import { describe, it, expect } from 'vitest';
import { planRelaunchBounce, type RigPresenceEvidence } from './rig-relaunch-guard';
import { emptyRigBindings, type RigBindings } from './device-slot-bindings';

const SCREEN_A = {
  label: 'Built-in Retina',
  isInternal: true,
  width: 3024,
  height: 1964,
  dpr: 2,
  left: 0,
  top: 0,
};
const SCREEN_B = {
  label: 'DELL U2720Q',
  isInternal: false,
  width: 3840,
  height: 2160,
  dpr: 2,
  left: 3024,
  top: 0,
};

/** Fully-indeterminate evidence — every leg null. The planner must never bounce
 *  on this (the shape a plain browser route mount produces). */
const BLIND: RigPresenceEvidence = { videoInputs: null, screens: null, helpers: null };

function rig(patch: Partial<RigBindings>): RigBindings {
  return { ...emptyRigBindings(), ...patch };
}

describe('planRelaunchBounce', () => {
  it('never bounces an empty rig, whatever the evidence', () => {
    expect(planRelaunchBounce(emptyRigBindings(), BLIND).bounce).toBe(false);
    expect(
      planRelaunchBounce(emptyRigBindings(), {
        videoInputs: [],
        screens: [SCREEN_A],
        helpers: { es9: 'stopped', ptz: 'stopped' },
      }).bounce,
    ).toBe(false);
  });

  it('never bounces on indeterminate evidence even with everything bound', () => {
    const b = rig({
      cameras: { cam1: { deviceId: 'd1', deviceLabel: 'Studio Cam' } },
      outputs: { output1: { screen: SCREEN_B } },
      es9: { pushPolicy: 'auto' },
      ptz: { deviceId: 'PT-PTZ-CAM1' },
    });
    expect(planRelaunchBounce(b, BLIND).bounce).toBe(false);
  });

  // ── CAMERAS ────────────────────────────────────────────────────────────
  it('keeps a bound camera present by deviceId', () => {
    const b = rig({ cameras: { cam1: { deviceId: 'd1', deviceLabel: 'Studio Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: 'd1', label: 'Studio Cam' }],
      screens: null,
      helpers: null,
    };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  it('keeps a bound camera present by LABEL when the deviceId hash rotated', () => {
    const b = rig({ cameras: { cam1: { deviceId: 'old-hash', deviceLabel: 'Studio Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: 'new-hash', label: 'Studio Cam' }],
      screens: null,
      helpers: null,
    };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  it('bounces when a bound camera is absent from a real device list', () => {
    const b = rig({ cameras: { cam2: { deviceId: 'gone', deviceLabel: 'Old Cam' } } });
    const ev: RigPresenceEvidence = {
      videoInputs: [{ deviceId: 'other', label: 'Some Other Cam' }],
      screens: null,
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
      screens: null,
      helpers: null,
    };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  // ── DISPLAYS ───────────────────────────────────────────────────────────
  it('keeps a bound display that still resolves against the live set', () => {
    const b = rig({ outputs: { output1: { screen: SCREEN_B } } });
    const ev: RigPresenceEvidence = { videoInputs: null, screens: [SCREEN_A, SCREEN_B], helpers: null };
    expect(planRelaunchBounce(b, ev).bounce).toBe(false);
  });

  it('bounces when the bound display is gone from the live set', () => {
    const b = rig({ outputs: { output1: { screen: SCREEN_B } } });
    const ev: RigPresenceEvidence = { videoInputs: null, screens: [SCREEN_A], helpers: null };
    const d = planRelaunchBounce(b, ev);
    expect(d.bounce).toBe(true);
    expect(d.reason).toContain('output1');
  });

  // ── HELPERS ────────────────────────────────────────────────────────────
  it('bounces a configured ES-9 whose helper is stopped, but not a running one', () => {
    const b = rig({ es9: { pushPolicy: 'auto' } });
    expect(
      planRelaunchBounce(b, { videoInputs: null, screens: null, helpers: { es9: 'stopped' } }).bounce,
    ).toBe(true);
    expect(
      planRelaunchBounce(b, { videoInputs: null, screens: null, helpers: { es9: 'running' } }).bounce,
    ).toBe(false);
    // transient restart states must not bounce (the relaunch races the boot)
    expect(
      planRelaunchBounce(b, { videoInputs: null, screens: null, helpers: { es9: 'starting' } })
        .bounce,
    ).toBe(false);
  });

  it('does not bounce a stopped helper the rig never configured', () => {
    // es9 helper down, but nothing bound to ES-9 → not this rig's problem.
    expect(
      planRelaunchBounce(emptyRigBindings(), {
        videoInputs: null,
        screens: null,
        helpers: { es9: 'stopped' },
      }).bounce,
    ).toBe(false);
  });

  it('bounces a configured PTZ whose helper crash-looped', () => {
    const b = rig({ ptz: { deviceId: 'PT-PTZ-CAM1' } });
    const d = planRelaunchBounce(b, {
      videoInputs: null,
      screens: null,
      helpers: { ptz: 'crash-looped' },
    });
    expect(d.bounce).toBe(true);
    expect(d.reason).toContain('PTZ');
  });

  it('joins multiple absence reasons', () => {
    const b = rig({
      cameras: { cam1: { deviceId: 'gone', deviceLabel: 'Old Cam' } },
      outputs: { output1: { screen: SCREEN_B } },
    });
    const d = planRelaunchBounce(b, {
      videoInputs: [{ deviceId: 'x', label: 'Other' }],
      screens: [SCREEN_A],
      helpers: null,
    });
    expect(d.bounce).toBe(true);
    expect(d.reason).toContain('cam1');
    expect(d.reason).toContain('output1');
  });
});
