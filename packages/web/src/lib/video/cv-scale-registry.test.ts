// packages/web/src/lib/video/cv-scale-registry.test.ts
//
// VIDEO-domain twin of packages/web/src/lib/audio/cv-scale-registry.test.ts.
//
// The cross-domain cv → video bridge (lib/video/cv-bridge-map.ts, driven by
// engine.ts tickCvBridges) decides how a sampled CV value is applied to a
// video module's input:
//
//   - a `cv` input that DECLARES a `cvScale` hint  → CONTINUOUS knob modulator:
//     the value is scaled across the target param's [min,max] range CENTERED on
//     the current knob (scaleCv), so a ±1 source sweeps the full range. CORRECT.
//   - a `cv` input with NO `cvScale`               → GATE semantics: the RAW
//     sample is written straight to setParam(paramTarget). Correct ONLY for
//     gate/trigger inputs the module edge-detects (or raw game-control inputs);
//     WRONG for a continuous knob modulator (a bipolar ±1 source clobbers the
//     knob + lands outside the 0..1 range → the CV input appears dead).
//
// So EVERY `cv` input that targets a real continuous knob param MUST carry a
// `cvScale` hint. This test pins that: every `cv` input with a `paramTarget`
// either has `cvScale` OR is in VIDEO_PASSTHROUGH_BY_DESIGN (a documented gate /
// raw-signal allowlist). Without this guard the audio cv-scale-registry test
// (which iterates ONLY the AUDIO registry) left every video module's missing
// cvScale unguarded — the gap that let OUTLINES + 13 siblings ship with dead
// CV inputs (this test would have caught all of them).

import { describe, it, expect } from 'vitest';
import { collectVideoDefs } from '$lib/video/modules';

// Video modules whose `cv`-typed input(s) INTENTIONALLY omit `cvScale`. Every
// entry is a GATE/TRIGGER input the module edge-detects (paramTarget is a
// synthetic param the module samples raw), or a RAW game-control input the
// module consumes directly — NOT a continuous knob modulator. New entries here
// MUST be justified one-liner-per-port (mirrors the audio PASSTHROUGH_BY_DESIGN
// convention + .myrobots/plans/cv-range-standard.md).
const VIDEO_PASSTHROUGH_BY_DESIGN: Record<string, string[]> = {
  // 4PLEXVID gate1..gate4: per-output GATE inputs routed onto synthetic gateN
  // params the factory EDGE-DETECTS (gateStates) to advance the active source.
  // Raw passthrough is the gate contract; scaling would corrupt the edge.
  '4plexvid': ['gate1', 'gate2', 'gate3', 'gate4'],
  // SCOREBOARD score/reset: GATE inputs onto synthetic scoreTrig/resetTrig
  // params; the factory edge-detects rising edges to increment / clear the
  // counter. Raw passthrough by design (mirrors acidwarp's sceneTrig).
  scoreboard: ['score', 'reset'],
  // ACIDWARP scene_cv: a GATE onto the synthetic sceneTrig param; draw()
  // detects rising edges to advance the plasma scene. speed_cv (the one
  // CONTINUOUS input) correctly carries cvScale.
  acidwarp: ['scene_cv'],
  // BACKDRAFT delay_clock / mirror_x_gate / mirror_y_gate / shape_gate /
  // pure_geo_gate: GATE/clock inputs onto synthetic delayClock / mirrorXGate /
  // mirrorYGate / shapeGate / pureGeoGate params the module edge-detects (clock →
  // delay period; rising edge → flip mirror axis / cycle shape / toggle pure
  // geo). Every CONTINUOUS backdraft input already carries cvScale.
  backdraft: ['delay_clock', 'mirror_x_gate', 'mirror_y_gate', 'shape_gate', 'pure_geo_gate'],
  // B3NTB0X mirror_x_gate / mirror_y_gate: GATE inputs onto synthetic
  // mirrorXGate/mirrorYGate params; a rising edge toggles the mirror axis. All
  // continuous *_cv inputs already carry cvScale.
  b3ntb0x: ['mirror_x_gate', 'mirror_y_gate'],
  // BENTBOX mirror_x_gate / mirror_y_gate: same gate-toggle shape as B3NTB0X /
  // BACKDRAFT. All continuous *_cv inputs already carry cvScale.
  bentbox: ['mirror_x_gate', 'mirror_y_gate'],
  // DOOM cv-gate inputs: the per-slot p{1..4}_{up,down,…} fire gates plus the
  // iddqd_in / idkfa_in cheat triggers. Each targets a synthetic cv_* param
  // that drives the WASM key queue via a per-(slot,port) EDGE DETECTOR. Raw
  // passthrough is required so the lockstep TicSet stays deterministic; scaling
  // would distort the rise/fall the detector keys off. (The list is generated
  // from CV_GATE_PORT_IDS_BY_SLOT, so it's resolved at runtime below.)
  doom: ['iddqd_in', 'idkfa_in'], // p{slot}_{base} gates added programmatically below
  // BLOOD cv-gate inputs: the 13 game-control gates/triggers targeting synthetic
  // cv_* params that drive the NBlood key FIFO via an edge detector — raw
  // passthrough by design (like DOOM), no continuous knob; scaling would distort
  // the rise/fall the detector keys off.
  blood: ['up', 'down', 'left', 'right', 'fire', 'altfire', 'use', 'jump', 'crouch', 'weapnext', 'weapprev', 'esc', 'enter'],
};

// DOOM declares its per-slot fire gates programmatically (p1_up … p4_use), so
// resolve them from the live def rather than hard-coding 28 ids. They are all
// the cv-gate inputs whose paramTarget is `cv_<portId>` (the edge-detector
// shape) — i.e. every cv input that ISN'T already allow-listed above.
function expandDoomGatePorts(): void {
  const doom = collectVideoDefs().find((d) => d.type === 'doom');
  if (!doom) return;
  const fixed = new Set(VIDEO_PASSTHROUGH_BY_DESIGN.doom);
  for (const port of doom.inputs) {
    if (port.type !== 'cv') continue;
    if (port.paramTarget === `cv_${port.id}`) fixed.add(port.id);
  }
  VIDEO_PASSTHROUGH_BY_DESIGN.doom = [...fixed];
}

describe('video cv-scale / registry coverage', () => {
  expandDoomGatePorts();

  it('every video module CV input either has cvScale or is in VIDEO_PASSTHROUGH_BY_DESIGN', () => {
    const offenders: Array<{ module: string; port: string; reason: string }> = [];
    for (const def of collectVideoDefs()) {
      for (const port of def.inputs) {
        if (port.type !== 'cv') continue;
        if (port.cvScale) continue; // explicit hint present → continuous, OK
        const passthroughOk = VIDEO_PASSTHROUGH_BY_DESIGN[def.type as string] ?? [];
        if (passthroughOk.includes(port.id)) continue;
        offenders.push({
          module: def.type as string,
          port: port.id,
          reason: port.paramTarget
            ? `cv → setParam(${port.paramTarget}) without cvScale; the cv→video bridge will treat it as a GATE (raw passthrough), clobbering the knob + sending a bipolar ±1 source outside the param range → the CV input is dead. Add cvScale: { mode: 'linear'|'log'|'discrete' } for a continuous knob, or list it in VIDEO_PASSTHROUGH_BY_DESIGN with a justification if it's a gate/raw input.`
            : `cv input without paramTarget; if it modulates a knob add paramTarget + cvScale, otherwise list it in VIDEO_PASSTHROUGH_BY_DESIGN with the rationale.`,
        });
      }
    }
    expect(
      offenders,
      `Video modules with CV inputs lacking cvScale (and not in VIDEO_PASSTHROUGH_BY_DESIGN):\n` +
        offenders.map((o) => `  - ${o.module}.${o.port}: ${o.reason}`).join('\n'),
    ).toEqual([]);
  });

  it('every video cvScale.paramTarget points at a real param', () => {
    const broken: Array<{ module: string; port: string; paramTarget: string }> = [];
    for (const def of collectVideoDefs()) {
      for (const port of def.inputs) {
        if (!port.cvScale || !port.paramTarget) continue;
        const param = def.params.find((p) => p.id === port.paramTarget);
        if (!param) {
          broken.push({
            module: def.type as string,
            port: port.id,
            paramTarget: port.paramTarget,
          });
        }
      }
    }
    expect(
      broken,
      `Video cvScale ports whose paramTarget resolves to no param:\n` +
        broken.map((b) => `  - ${b.module}.${b.port} → ${b.paramTarget}`).join('\n'),
    ).toEqual([]);
  });

  it('every VIDEO_PASSTHROUGH_BY_DESIGN entry corresponds to a real cv input (no rot)', () => {
    const stale: string[] = [];
    const defsByType = new Map(collectVideoDefs().map((d) => [d.type as string, d]));
    for (const [type, ports] of Object.entries(VIDEO_PASSTHROUGH_BY_DESIGN)) {
      const def = defsByType.get(type);
      if (!def) {
        stale.push(`${type} (no such video module)`);
        continue;
      }
      for (const portId of ports) {
        const port = def.inputs.find((p) => p.id === portId);
        if (!port) stale.push(`${type}.${portId} (no such input port)`);
        else if (port.type !== 'cv') stale.push(`${type}.${portId} (not a cv input: ${port.type})`);
        else if (port.cvScale) stale.push(`${type}.${portId} (now HAS cvScale — drop from allowlist)`);
      }
    }
    expect(stale, `Stale VIDEO_PASSTHROUGH_BY_DESIGN entries:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
