// packages/web/src/lib/ui/connect-drag-state.test.ts
//
// Regression coverage for the cable-drop highlight bug: while a connect
// gesture is in flight, the document-level pointermove tracker has to
// publish whichever svelte-flow node is under the cursor so PatchPanel
// can auto-open. Without this, the destination panel only opens when
// the cursor lands on the tiny corner trigger glyph — which never
// happens during a real cable drag because the cursor follows the
// cable endpoint.
//
// Vitest here runs in node (see vitest.config.ts — jsdom isn't installed),
// so we stub the global `document` enough to exercise the hover tracker's
// install + dispatch + uninstall lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDragState } from './connect-drag-state.svelte';

interface ListenerEntry {
  type: string;
  fn: (e: PointerEvent) => void;
}

interface MockNode {
  className: string;
  dataset: Record<string, string>;
  closest(selector: string): MockNode | null;
}

function makeFlowNode(id: string): MockNode {
  const node: MockNode = {
    className: `svelte-flow__node svelte-flow__node-foo`,
    dataset: { id },
    closest(selector: string) {
      return selector === '.svelte-flow__node' ? node : null;
    },
  };
  return node;
}

describe('connectDragState hover tracker', () => {
  let listeners: ListenerEntry[];
  let elementUnderPoint: MockNode | null;

  beforeEach(() => {
    listeners = [];
    elementUnderPoint = null;
    vi.stubGlobal('document', {
      addEventListener: (type: string, fn: (e: PointerEvent) => void) => {
        listeners.push({ type, fn });
      },
      removeEventListener: (type: string, fn: (e: PointerEvent) => void) => {
        const idx = listeners.findIndex((l) => l.type === type && l.fn === fn);
        if (idx >= 0) listeners.splice(idx, 1);
      },
      elementFromPoint: () => elementUnderPoint,
    });
  });

  afterEach(() => {
    connectDragState.end();
    connectDragState.cancelPickup();
    vi.unstubAllGlobals();
  });

  function move(): void {
    for (const { type, fn } of listeners) {
      if (type === 'pointermove') fn({ clientX: 0, clientY: 0 } as PointerEvent);
    }
  }

  it('publishes the node under the cursor while a drag is in flight', () => {
    expect(connectDragState.hoveredCardNodeId).toBeNull();
    connectDragState.begin();
    expect(listeners.length, 'pointermove listener installed').toBe(1);

    elementUnderPoint = makeFlowNode('vco-1');
    move();
    expect(connectDragState.hoveredCardNodeId).toBe('vco-1');

    elementUnderPoint = null;
    move();
    expect(connectDragState.hoveredCardNodeId).toBeNull();

    connectDragState.end();
    expect(listeners.length, 'listener torn down on end').toBe(0);
    expect(connectDragState.hoveredCardNodeId).toBeNull();
  });

  it('publishes the node under the cursor while a pickup-mode cable is sticky', () => {
    connectDragState.pickup({ nodeId: 'src', portId: 'out', handleType: 'source' });
    expect(listeners.length).toBe(1);
    elementUnderPoint = makeFlowNode('vco-7');
    move();
    expect(connectDragState.hoveredCardNodeId).toBe('vco-7');
    connectDragState.cancelPickup();
    expect(listeners.length).toBe(0);
    expect(connectDragState.hoveredCardNodeId).toBeNull();
  });

  it('does not track when idle (no listener installed)', () => {
    expect(listeners.length).toBe(0);
    move();
    expect(connectDragState.hoveredCardNodeId).toBeNull();
  });
});
