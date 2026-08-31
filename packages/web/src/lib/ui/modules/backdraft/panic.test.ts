// packages/web/src/lib/ui/modules/backdraft/panic.test.ts
//
// BACKDRAFT PANIC — the ONE reset implementation (./panic.ts), tested against
// the REAL seams end to end:
//
//   * the LIVE graph store (graph/store.ts — real syncedStore + Y.Doc +
//     UndoManager, the mutate.test.ts discipline), so the "one undoable step"
//     claim is exercised on the exact `trackedOrigins` wiring undo uses;
//   * the REAL VideoEngine over a Proxy GL stub (the backdraft-gate-edges /
//     b3ntb0x precedent) running the REAL backdraft factory, so the engine
//     push, the gate-flip divergence and the CV re-centre are the shipped code
//     paths, not mirrors of them;
//   * a REAL addCvBridge fed by a fake AnalyserNode, so "CV keeps modulating
//     around the restored default base" is measured through tickCvBridges'
//     own per-tick re-centre (#2236), which is the mechanism the claim rests
//     on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store';
import { setActiveEngine } from '$lib/audio/engine-ref';
import type { PatchEngine } from '$lib/audio/engine';
import { VideoEngine } from '$lib/video/engine';
import { setVideoPanicHandler } from '$lib/video/panic-hook';
import { backdraftDef } from '$lib/video/modules/backdraft';
import { noUserControlIds } from '$lib/ui/workflow/no-user-control';
import type { ModuleNode } from '$lib/graph/types';
import { backdraftPanic, backdraftPanicTargets } from './panic';
// Side-effect: registers the video defs so VideoEngine.addNode resolves them.
import '$lib/video/modules';

const NID = 'bd-panic-test';

// The GL stub — a Proxy so a shader/uniform call added to backdraft later
// cannot silently break this file (the backdraft-gate-edges.test.ts shape,
// extended for the REAL engine path: GL enum constants must read as NUMBERS,
// because createFboImpl compares checkFramebufferStatus() against
// gl.FRAMEBUFFER_COMPLETE — both read 0 here, so the check passes).
function makeFakeGl(): WebGL2RenderingContext {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        const p = String(prop);
        if (p.startsWith('create') || p === 'getUniformLocation') return () => ({});
        if (p === 'getProgramParameter' || p === 'getShaderParameter') return () => true;
        if (p === 'getExtension') return () => null;
        if (/^[A-Z][A-Z0-9_]*$/.test(p)) return 0; // enum constants
        return () => 0;
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

function makeHeadlessEngine(): VideoEngine {
  const canvas = {
    width: 320,
    height: 240,
    getContext: () => makeFakeGl(),
  } as unknown as HTMLCanvasElement;
  return new VideoEngine({ canvas });
}

/** An AnalyserNode whose whole window reads `value()` — the cv/gate bridge
 *  takes the tail sample, so this IS the live CV level. */
function makeFakeAnalyser(value: () => number): AnalyserNode {
  return {
    fftSize: 128,
    getFloatTimeDomainData: (buf: Float32Array) => buf.fill(value()),
  } as unknown as AnalyserNode;
}

/** A non-default in-range value for every param PANIC resets. Derived, so a
 *  new param is automatically twiddled too (no hand list to go stale). */
function twiddledValue(p: { id: string; defaultValue: number }): number {
  const def = backdraftDef.params.find((d) => d.id === p.id)!;
  const v = def.defaultValue === def.min ? def.max : def.min;
  expect(v, `twiddle for '${p.id}' must differ from its default`).not.toBe(def.defaultValue);
  return v;
}

function makeNode(params: Record<string, number> = {}): void {
  ydoc.transact(() => {
    patch.nodes[NID] = {
      id: NID,
      type: 'backdraft',
      domain: 'video',
      position: { x: 12, y: 34 },
      params,
      data: { name: 'my backdraft', previewCollapsed: true, fullFrame: false },
    } as ModuleNode;
    patch.edges['e-keep'] = {
      id: 'e-keep',
      source: { nodeId: 'some-lfo', portId: 'out' },
      target: { nodeId: NID, portId: 'zoom' },
      sourceType: 'cv',
      targetType: 'cv',
    };
  }, LOCAL_ORIGIN);
  undoManager.clear();
  undoManager.stopCapturing();
}

beforeEach(() => {
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  undoManager.clear();
  undoManager.stopCapturing();
});

afterEach(() => {
  setActiveEngine(null);
  setVideoPanicHandler(null);
  for (const id of Object.keys(patch.nodes)) delete patch.nodes[id];
  for (const id of Object.keys(patch.edges)) delete patch.edges[id];
  undoManager.clear();
});

describe('backdraftPanicTargets — derived membership', () => {
  it('covers exactly the def params NOT declared noUserControl, both directions', () => {
    const hidden = noUserControlIds(backdraftDef);
    const targetIds = new Set(backdraftPanicTargets().map((p) => p.id));
    for (const p of backdraftDef.params) {
      expect(
        targetIds.has(p.id),
        `'${p.id}' (noUserControl=${hidden.has(p.id)}) must be reset iff user-settable`,
      ).toBe(!hidden.has(p.id));
    }
  });
});

describe('backdraftPanic — the doc reset', () => {
  it('resets every user-settable param to its def default', () => {
    const targets = backdraftPanicTargets();
    const twiddled: Record<string, number> = {};
    for (const p of targets) twiddled[p.id] = twiddledValue(p);
    makeNode(twiddled);

    expect(backdraftPanic(NID)).toBe(true);

    for (const p of targets) {
      expect(patch.nodes[NID]!.params[p.id], `'${p.id}' back to default`).toBe(p.defaultValue);
    }
  });

  it('is ONE undoable step: Cmd-Z restores the whole pre-panic state at once', () => {
    const targets = backdraftPanicTargets();
    const twiddled: Record<string, number> = {};
    for (const p of targets) twiddled[p.id] = twiddledValue(p);
    makeNode(twiddled);

    backdraftPanic(NID);
    expect(undoManager.undoStack.length, 'one transaction = one undo entry').toBe(1);

    undoManager.undo();
    for (const p of targets) {
      expect(patch.nodes[NID]!.params[p.id], `undo restores '${p.id}'`).toBe(twiddled[p.id]);
    }
  });

  it('leaves patching, layout, identity, view state and noUserControl params untouched', () => {
    // A stray persisted value on a hidden gate param is NOT a setting — panic
    // must not write it (and must never write panicGate, its own trigger).
    makeNode({ mix: 0.1, panicGate: 0.7, delayClock: 0.3 });

    backdraftPanic(NID);
    const n = patch.nodes[NID]!;

    expect(patch.edges['e-keep'], 'the patched cable is untouched').toBeDefined();
    expect(n.position, 'layout untouched').toEqual({ x: 12, y: 34 });
    expect(n.data, 'identity + view state untouched').toEqual({
      name: 'my backdraft',
      previewCollapsed: true,
      fullFrame: false,
    });
    expect(n.params.panicGate, 'noUserControl param untouched').toBe(0.7);
    expect(n.params.delayClock, 'noUserControl param untouched').toBe(0.3);
    expect(n.params.mix, 'the setting DID reset').toBe(0.5);
  });

  it('an already-default rack is a silent no-op — no undo churn', () => {
    makeNode({});
    expect(backdraftPanic(NID)).toBe(true);
    expect(undoManager.undoStack.length, 'nothing written, nothing to undo').toBe(0);
  });

  it('a missing node or a non-backdraft node is a safe no-op', () => {
    expect(backdraftPanic('no-such-node')).toBe(false);
    ydoc.transact(() => {
      patch.nodes['not-bd'] = {
        id: 'not-bd', type: 'lines', domain: 'video',
        position: { x: 0, y: 0 }, params: { amp: 42 },
      } as ModuleNode;
    }, LOCAL_ORIGIN);
    expect(backdraftPanic('not-bd')).toBe(false);
    expect(patch.nodes['not-bd']!.params.amp).toBe(42);
  });
});

describe('backdraftPanic — the engine push (real VideoEngine, real factory)', () => {
  function wireActiveEngine(ve: VideoEngine): void {
    setActiveEngine({
      hasDomain: (d: string) => d === 'video',
      getDomain: () => ve,
    } as unknown as PatchEngine);
  }

  it('resets gate-flipped ENGINE-LOCAL state the doc write alone cannot reach', async () => {
    // A mirror_x_gate rising edge flips the HANDLE's mirrorX and never writes
    // the doc — so doc already holds the default, the in-place doc skip writes
    // nothing, and only the engine push can bring the module back.
    makeNode({});
    const ve = makeHeadlessEngine();
    await ve.addNode(patch.nodes[NID] as ModuleNode);
    wireActiveEngine(ve);

    const handle = ve.getNodeHandle(NID)!;
    handle.setParam('mirrorXGate', 0);
    handle.setParam('mirrorXGate', 1);
    expect(handle.readParam('mirrorX'), 'gate flip diverged the engine').toBe(1);
    expect(patch.nodes[NID]!.params.mirrorX ?? 0, 'while the doc still holds default').toBe(0);

    backdraftPanic(NID);
    expect(handle.readParam('mirrorX'), 'panic resets the engine-local flip').toBe(0);
  });

  it('CV RIDES ON TOP: after panic the BASE is the default while the modulated value still moves', async () => {
    makeNode({ zoom: 1.2 });
    const ve = makeHeadlessEngine();
    await ve.addNode(patch.nodes[NID] as ModuleNode);
    wireActiveEngine(ve);

    let cv = 0.25;
    ve.addCvBridge('e-zoom-cv', makeFakeAnalyser(() => cv), NID, 'zoom', () => {}, 'cv');
    const handle = ve.getNodeHandle(NID)!;
    const zoomDef = backdraftDef.params.find((p) => p.id === 'zoom')!;
    const halfSpan = (zoomDef.max - zoomDef.min) / 2; // linear cvScale: ±1 sweeps the full range

    ve.step();
    expect(handle.readParam('zoom'), 'cv modulates around the twiddled base (engine units)')
      .toBeCloseTo(1.2 + cv * halfSpan, 6);

    backdraftPanic(NID);
    ve.step();
    // The BASE is the default — in the doc and in the engine's baseParams
    // (which tickCvBridges re-centres on every tick, #2236) — while the live
    // CV keeps riding on top of it.
    expect(patch.nodes[NID]!.params.zoom, 'doc base = default').toBe(zoomDef.defaultValue);
    expect(handle.readParam('zoom'), 'effective value = default base + cv swing (engine units)')
      .toBeCloseTo(zoomDef.defaultValue + cv * halfSpan, 6);

    cv = -0.25;
    ve.step();
    expect(handle.readParam('zoom'), 'the modulated value still MOVES with the cv (engine units)')
      .toBeCloseTo(zoomDef.defaultValue + cv * halfSpan, 6);
  });
});

describe('the panic GATE — a rising edge fires the SAME reset as the button', () => {
  it('fires the registered hook exactly once per rising edge; a held gate fires once', async () => {
    makeNode({});
    const ve = makeHeadlessEngine();
    await ve.addNode(patch.nodes[NID] as ModuleNode);
    const handle = ve.getNodeHandle(NID)!;

    const hook = vi.fn();
    setVideoPanicHandler(hook);

    // The bridge replay convention: setParam(0); setParam(1) per counted edge,
    // then the settled level (installGateDispatch, audio/engine.ts).
    handle.setParam('panicGate', 0);
    handle.setParam('panicGate', 1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(NID);

    handle.setParam('panicGate', 1); // held high — no second fire
    expect(hook).toHaveBeenCalledTimes(1);

    handle.setParam('panicGate', 0);
    handle.setParam('panicGate', 1); // second edge — second fire
    expect(hook).toHaveBeenCalledTimes(2);

    expect(handle.read?.('panicCount'), 'the monotonic acted-on probe').toBe(2);
  });

  it('with the production wiring the edge resets the doc (one implementation, two triggers)', async () => {
    const targets = backdraftPanicTargets();
    const twiddled: Record<string, number> = {};
    for (const p of targets) twiddled[p.id] = twiddledValue(p);
    makeNode(twiddled);
    const ve = makeHeadlessEngine();
    await ve.addNode(patch.nodes[NID] as ModuleNode);
    setActiveEngine({
      hasDomain: (d: string) => d === 'video',
      getDomain: () => ve,
    } as unknown as PatchEngine);
    // Exactly what Canvas.svelte registers at engine boot.
    setVideoPanicHandler((nodeId) => { backdraftPanic(nodeId); });

    const handle = ve.getNodeHandle(NID)!;
    handle.setParam('panicGate', 0);
    handle.setParam('panicGate', 1);

    for (const p of targets) {
      expect(patch.nodes[NID]!.params[p.id], `gate reset '${p.id}' to default`).toBe(p.defaultValue);
    }
    expect(undoManager.undoStack.length, 'gate panic is one undoable step too').toBe(1);
  });
});
