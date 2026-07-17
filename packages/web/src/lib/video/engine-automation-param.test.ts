// packages/web/src/lib/video/engine-automation-param.test.ts
//
// Regression coverage for VIDEO-param clip-automation drive + the NO-STUCK
// guarantee (fix/video-automation).
//
// Two bugs this pins:
//   1. Clip-automation could not drive a video param at all. The clip-player
//      playback seam calls engine.scheduleParam / holdParam / setDisplayParam,
//      which the PatchEngine facade dispatches to the target domain via
//      OPTIONAL chaining. VideoEngine implemented only setParam, so all three
//      silently no-op'd → video automation never recorded/played back.
//   2. Worse: once a transient driver (automation OR a CV bridge) had written a
//      video uniform, the control was STUCK. The reconciler only re-pushes
//      node.params on a CHANGE vs its own applied snapshot, which never
//      changed, so manual control was dead after the driver stopped.
//
// The fix routes scheduleParam/holdParam/setDisplayParam onto the uniform as
// TRANSIENT drives that record a manual BASE, and a per-frame sweep restores
// the base once the modulation goes stale — so manual control always returns.
//
// Node-env vitest with a stub GL context (the engine's param bookkeeping is
// pure JS — no real WebGL needed; the render itself is covered by the e2e).

import { afterEach, describe, expect, it } from 'vitest';
import { VideoEngine, type VideoNodeHandle } from '$lib/video/engine';
import { registerVideoModule } from '$lib/video/module-registry';
import type { ModuleNode } from '$lib/graph/types';

const HOLD_FRAMES = 10; // must mirror VideoEngine.TRANSIENT_HOLD_FRAMES

/** A stub video module whose handle stores its param values so a test can read
 *  back exactly what reached the (would-be) uniform. */
function makeEngineWithParamNode(initialParams: Record<string, number> = {}): {
  engine: VideoEngine;
  nodeId: string;
  read: (paramId: string) => number | undefined;
} {
  const glStub = {} as unknown as WebGL2RenderingContext;
  const canvas = { width: 1, height: 1, getContext: () => glStub } as unknown as HTMLCanvasElement;
  const engine = new VideoEngine({ canvas });

  const params: Record<string, number> = { orient: 0, ...initialParams };
  const handle: VideoNodeHandle = {
    domain: 'video',
    surface: { fbo: null, texture: null, draw: () => {}, dispose: () => {} },
    setParam: (id, v) => { params[id] = v; },
    readParam: (id) => params[id],
    dispose: () => {},
  };

  const stubType = ('param-spy-' + Math.random().toString(36).slice(2)) as ModuleNode['type'];
  registerVideoModule({
    type: stubType,
    domain: 'video',
    label: 'param-spy',
    category: 'sources',
    inputs: [{ id: 'orient', type: 'cv', paramTarget: 'orient', cvScale: { mode: 'linear' } }],
    outputs: [{ id: 'out', type: 'video' }],
    params: [{ id: 'orient', label: 'Orient', defaultValue: 0, min: 0, max: 1, curve: 'linear' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: (() => handle) as any,
  });

  const node = {
    id: 'spy', type: stubType, domain: 'video',
    position: { x: 0, y: 0 }, params: { ...initialParams },
  } as ModuleNode;
  void engine.addNode(node);

  return { engine, nodeId: 'spy', read: (p) => engine.readParam('spy', p) };
}

describe('video clip-automation param drive + no-stuck', () => {
  let live: VideoEngine | null = null;
  afterEach(() => { live?.dispose(); live = null; });

  it('scheduleParam DRIVES the uniform (playback reaches video)', () => {
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.setParam(nodeId, 'orient', 0.2); // manual base
    expect(read('orient')).toBeCloseTo(0.2);

    // Clip-automation playback drive → the value MUST reach the uniform.
    engine.scheduleParam(nodeId, 'orient', 0.85, 0, false);
    expect(read('orient')).toBeCloseTo(0.85);
  });

  it('setDisplayParam + holdParam(value) also drive the uniform', () => {
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.setDisplayParam(nodeId, 'orient', 0.4);
    expect(read('orient')).toBeCloseTo(0.4);
    engine.holdParam(nodeId, 'orient', 0, 0.66, 0);
    expect(read('orient')).toBeCloseTo(0.66);
  });

  it('holdParam with no value is a no-op (nothing to cancel for video)', () => {
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.setParam(nodeId, 'orient', 0.3);
    engine.holdParam(nodeId, 'orient', 0); // truncate/anchor — no toValue
    expect(read('orient')).toBeCloseTo(0.3);
  });

  it('an ACTIVE driver holds the value across frames (no premature restore)', () => {
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.setParam(nodeId, 'orient', 0.1);
    for (let i = 0; i < HOLD_FRAMES + 5; i++) {
      engine.scheduleParam(nodeId, 'orient', 0.9, 0, false); // keep driving
      engine.step();
    }
    expect(read('orient'), 'a continuously-driven param stays driven').toBeCloseTo(0.9);
  });

  it('NO STUCK CONTROL: base restores after the driver stops', () => {
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.setParam(nodeId, 'orient', 0.2); // manual base
    engine.scheduleParam(nodeId, 'orient', 0.85, 0, false); // automation drove it
    expect(read('orient')).toBeCloseTo(0.85);

    // Driver STOPS (clip deleted / lane stopped): step frames with no drive.
    for (let i = 0; i < HOLD_FRAMES + 3; i++) engine.step();

    // The uniform MUST return to the manual base — control is not stuck.
    expect(read('orient'), 'stale automation restores the manual base').toBeCloseTo(0.2);
  });

  it('NO STUCK CONTROL: manual setParam works again after automation stops', () => {
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.setParam(nodeId, 'orient', 0.2);
    engine.scheduleParam(nodeId, 'orient', 0.85, 0, false);
    for (let i = 0; i < HOLD_FRAMES + 3; i++) engine.step();

    // A fresh manual move takes effect immediately (the reconciler seam).
    engine.setParam(nodeId, 'orient', 0.5);
    expect(read('orient')).toBeCloseTo(0.5);
    // And keeps working across frames (not re-clobbered by a ghost driver).
    for (let i = 0; i < HOLD_FRAMES + 3; i++) engine.step();
    expect(read('orient')).toBeCloseTo(0.5);
  });

  it('manual base seeded from the def default restores even if never set', () => {
    // Param never manually touched (base = def default 0), automation drives it,
    // then stops → must fall back to the default, not stay at the driven value.
    const { engine, nodeId, read } = makeEngineWithParamNode();
    live = engine;
    engine.scheduleParam(nodeId, 'orient', 0.7, 0, false);
    expect(read('orient')).toBeCloseTo(0.7);
    for (let i = 0; i < HOLD_FRAMES + 3; i++) engine.step();
    expect(read('orient'), 'restores to the def default base').toBeCloseTo(0);
  });
});
