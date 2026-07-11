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

describe('connectDragState carry-mode (redesigned jack-click flow)', () => {
  beforeEach(() => {
    // The carry methods install the document-level hover tracker, so stub
    // document the same way the hover-tracker suite does.
    vi.stubGlobal('document', {
      addEventListener: () => {},
      removeEventListener: () => {},
      elementFromPoint: () => null,
    });
  });

  afterEach(() => {
    connectDragState.cancelPickup();
    connectDragState.end();
    vi.unstubAllGlobals();
  });

  it('beginPickupWithMenu starts a pickup with the menu flag set + cable visible', () => {
    connectDragState.beginPickupWithMenu({ nodeId: 'src', portId: 'out', handleType: 'source' });
    expect(connectDragState.mode).toBe('pickup');
    expect(connectDragState.active).toBe(true);
    expect(connectDragState.pickupMenuOpen).toBe(true);
    expect(connectDragState.cableHidden).toBe(false);
    expect(connectDragState.pickupSource).toEqual({ nodeId: 'src', portId: 'out', handleType: 'source' });
  });

  it('plain pickup leaves the menu flag off', () => {
    connectDragState.pickup({ nodeId: 'src', portId: 'out', handleType: 'source' });
    expect(connectDragState.pickupMenuOpen).toBe(false);
    expect(connectDragState.cableHidden).toBe(false);
  });

  it('hideCableForPicker hides the ghost but RETAINS carry/source state (item 4)', () => {
    connectDragState.beginPickupWithMenu({ nodeId: 'src', portId: 'out', handleType: 'source' });
    connectDragState.hideCableForPicker();
    expect(connectDragState.cableHidden).toBe(true);
    // Carry survives — mode/source/active are all intact for the commit.
    expect(connectDragState.mode).toBe('pickup');
    expect(connectDragState.active).toBe(true);
    expect(connectDragState.pickupSource?.portId).toBe('out');
  });

  it('hideCableForPicker is a no-op when not carrying', () => {
    expect(connectDragState.mode).toBe('idle');
    connectDragState.hideCableForPicker();
    expect(connectDragState.cableHidden).toBe(false);
  });

  it('discard clears every pickup field back to idle (items 5 + 6)', () => {
    connectDragState.beginPickupWithMenu({ nodeId: 'src', portId: 'out', handleType: 'source' });
    connectDragState.hideCableForPicker();
    connectDragState.discard();
    expect(connectDragState.mode).toBe('idle');
    expect(connectDragState.active).toBe(false);
    expect(connectDragState.pickupSource).toBeNull();
    expect(connectDragState.pickupMenuOpen).toBe(false);
    expect(connectDragState.cableHidden).toBe(false);
  });

  it('cancelPickup also clears the menu + cableHidden flags', () => {
    connectDragState.beginPickupWithMenu({ nodeId: 'src', portId: 'out', handleType: 'source' });
    connectDragState.hideCableForPicker();
    connectDragState.cancelPickup();
    expect(connectDragState.pickupMenuOpen).toBe(false);
    expect(connectDragState.cableHidden).toBe(false);
  });
});

describe('connectDragState virtual-port pickup (workflow P3 primitive)', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      addEventListener: () => {},
      removeEventListener: () => {},
      elementFromPoint: () => null,
    });
  });

  afterEach(() => {
    connectDragState.cancelPickup();
    connectDragState.end();
    vi.unstubAllGlobals();
  });

  const virtual = () => ({
    anchor: { x: 40, y: 12 },
    cableType: 'video',
    resolve: async () => ({ nodeId: 'asset-node', portId: 'video' }),
  });

  it('beginVirtualPickup enters pickup mode with a sentinel source carrying the cable type', () => {
    connectDragState.beginVirtualPickup(virtual());
    expect(connectDragState.mode).toBe('pickup');
    expect(connectDragState.active).toBe(true);
    expect(connectDragState.pickupVirtual?.anchor).toEqual({ x: 40, y: 12 });
    // Sentinel source: matches no node, but colours the ghost + engages
    // the existing pickup readers (drag-lock, expand-all) unmodified.
    expect(connectDragState.pickupSource).toEqual({
      nodeId: '',
      portId: '',
      handleType: 'source',
      cableType: 'video',
    });
    expect(connectDragState.pickupMenuOpen).toBe(false);
  });

  it('cancelPickup / discard clear the virtual descriptor with the rest', () => {
    connectDragState.beginVirtualPickup(virtual());
    connectDragState.discard();
    expect(connectDragState.mode).toBe('idle');
    expect(connectDragState.pickupVirtual).toBeNull();
    expect(connectDragState.pickupSource).toBeNull();
  });

  it('starting a REAL pickup clears any stale virtual descriptor', () => {
    connectDragState.beginVirtualPickup(virtual());
    connectDragState.pickup({ nodeId: 'src', portId: 'out', handleType: 'source' });
    expect(connectDragState.pickupVirtual).toBeNull();
    expect(connectDragState.pickupSource?.nodeId).toBe('src');
    connectDragState.cancelPickup();
    connectDragState.beginVirtualPickup(virtual());
    connectDragState.beginPickupWithMenu({ nodeId: 's2', portId: 'out', handleType: 'source' });
    expect(connectDragState.pickupVirtual).toBeNull();
  });

  it('updatePickupCursor drives the ghost endpoint for virtual pickups too', () => {
    connectDragState.beginVirtualPickup(virtual());
    connectDragState.updatePickupCursor(300, 400);
    expect(connectDragState.pickupCursor).toEqual({ x: 300, y: 400 });
  });
});
