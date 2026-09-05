// packages/web/src/lib/ui/media/node-viz-surface-registry.test.ts
//
// The whole adoption decision table, on fake elements. Pure core + injected
// ops, so this runs in the web package's `environment: 'node'` vitest with no
// DOM at all — the same split `node-frame-producer-registry.test.ts` uses.
//
// ⚠ WHAT THIS FILE CANNOT SEE, said first. Nothing here proves that Canvas
// mounts the host, that the surface renders a canvas, that the viewer's box is
// unchanged, or that a picture ever arrives. Those are
// `card-producer-lifetime.spec.ts` (the producer with no surface anywhere) and
// `wavesculpt.spec.ts` (fifteen tests that photograph the adopted canvas
// through the DRS step seam). This file owns the ARBITRATION.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createNodeVizSurfaceRegistry,
  vizSurfaceTypes,
  VIZ_CLAIM_PRIORITY,
  type VizSurfaceOps,
} from './node-viz-surface-registry';
import { VIZ_SURFACE_PRODUCERS, NODE_VIZ_SURFACE_TYPES } from './node-viz-surfaces';

/** A fake element/host pair. Identity is all the core ever compares. */
type El = { id: string; parent: string | null };
type Host = { id: string };

function harness() {
  const moves: string[] = [];
  const ops: VizSurfaceOps<El, Host> = {
    mount(el, host) {
      el.parent = host.id;
      moves.push(`mount:${el.id}->${host.id}`);
    },
    park(el, park) {
      el.parent = park.id;
      moves.push(`park:${el.id}->${park.id}`);
    },
  };
  return { moves, reg: createNodeVizSurfaceRegistry<El, Host>(ops) };
}

const PARK: Host = { id: 'park' };
/** A SYNTHETIC lower-ranked claimant. ⚠ NOTHING IN THE PRODUCT CLAIMS BELOW
 *  `dock` today — the tier under it is the PARKED state, which is the absence
 *  of a claim rather than a claimant. The ranking is still a real mechanism, so
 *  it is exercised here with a declared number instead of a production tier
 *  invented to give the test something to point at. */
const LOWER = 1;
const LANE: Host = { id: 'lane' };
const DOCK: Host = { id: 'dock' };
const el = (): El => ({ id: 'canvas', parent: 'park' });

describe('node viz surfaces — the roster', () => {
  it('the TYPE SET is DERIVED from the roster, never a second literal', () => {
    expect([...NODE_VIZ_SURFACE_TYPES].sort()).toEqual(
      [...new Set(VIZ_SURFACE_PRODUCERS.map((p) => p.type))].sort(),
    );
    expect(VIZ_SURFACE_PRODUCERS.length, 'refusing to pass vacuously').toBeGreaterThan(0);
  });

  it('every member carries a WHY that says why a callback would not do', () => {
    for (const p of VIZ_SURFACE_PRODUCERS) {
      expect(p.why.length, `${p.type} needs a reason`).toBeGreaterThan(80);
    }
  });

  it('NEGATIVE CONTROL: the derivation follows the list rather than a memory of it', () => {
    expect([...vizSurfaceTypes([{ type: 'a', why: 'x' }, { type: 'b', why: 'y' }])].sort())
      .toEqual(['a', 'b']);
    expect(vizSurfaceTypes([]).size).toBe(0);
  });
});

describe('node-viz-surface-registry — publishing and parking', () => {
  it('a published surface with NO claim stays parked, and costs no DOM move', () => {
    const { reg, moves } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    expect(e.parent).toBe('park');
    expect(moves, 'the host already rendered it in the park — re-parenting it would be churn')
      .toEqual([]);
    expect(reg.showing('n1')).toBeNull();
    expect(reg.peek('n1')).toBe(e);
  });

  it('a claim MOVES the element; releasing it moves the element back', () => {
    const { reg, moves } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    const c = reg.claim('n1', LANE, LOWER);
    expect(e.parent).toBe('lane');
    expect(reg.showing('n1')).toBe(LANE);
    c.release();
    expect(e.parent).toBe('park');
    expect(reg.showing('n1')).toBeNull();
    expect(moves).toEqual(['mount:canvas->lane', 'park:canvas->park']);
  });

  it('release is IDEMPOTENT — a second release cannot steal the canvas from a new owner', () => {
    const { reg } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    const stale = reg.claim('n1', LANE, LOWER);
    stale.release();
    reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
    stale.release(); // the teardown a stale mount runs LATE
    expect(e.parent, 'the live owner keeps the element').toBe('dock');
  });

  it('a claim made BEFORE the surface is published is honoured when it arrives', () => {
    // Mount order is not guaranteed: a viewer can be in the lane before Canvas
    // has rendered the node host for the same node.
    const { reg } = harness();
    reg.claim('n1', LANE, LOWER);
    const e = el();
    reg.publish('n1', e, PARK);
    expect(e.parent).toBe('lane');
  });
});

describe('node-viz-surface-registry — arbitration between two live views', () => {
  it('the DOCK outranks the LANE however the mounts are ordered', () => {
    for (const laneFirst of [true, false]) {
      const { reg } = harness();
      const e = el();
      reg.publish('n1', e, PARK);
      if (laneFirst) {
        reg.claim('n1', LANE, LOWER);
        reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
      } else {
        reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
        reg.claim('n1', LANE, LOWER);
      }
      expect(e.parent, `lane mounted first: ${laneFirst}`).toBe('dock');
    }
  });

  it('⚠ CLOSING THE DOCK HANDS THE CANVAS BACK — the whole reason claims are a LIST', () => {
    // A bare last-wins transfer (the `nodeMedia.adopt` shape) cannot do this:
    // the lane claim would have been overwritten, so that viewer would sit with
    // an empty screen box until something remounted it.
    const { reg, moves } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    reg.claim('n1', LANE, LOWER);
    const dock = reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
    dock.release();
    expect(e.parent).toBe('lane');
    expect(moves).toEqual(['mount:canvas->lane', 'mount:canvas->dock', 'mount:canvas->lane']);
    // ...and never through the park on the way, which would blank the viewer for
    // a frame.
    expect(moves.filter((m) => m.startsWith('park:'))).toEqual([]);
  });

  it('two claims of the SAME priority fall back to last-wins, and unwind in order', () => {
    const { reg } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    const a = reg.claim('n1', LANE, LOWER);
    const b = reg.claim('n1', { id: 'lane2' }, LOWER);
    expect(e.parent).toBe('lane2');
    b.release();
    expect(e.parent, 'the older same-priority claim is still standing').toBe('lane');
    a.release();
    expect(e.parent).toBe('park');
  });

  it('a REPEATED resolve performs no DOM move — a re-render must not re-parent a live canvas', () => {
    const { reg, moves } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    reg.claim('n1', LANE, LOWER);
    const after = moves.length;
    // Same host, claimed again (an $effect that re-ran for an unrelated reason).
    reg.claim('n1', LANE, LOWER);
    expect(moves.length, 'idempotent resolve').toBe(after);
    expect(e.parent).toBe('lane');
  });
});

describe('node-viz-surface-registry — retract', () => {
  it('⚠ PARKS BEFORE FORGETTING, so a claimed element is home before its component dies', () => {
    const { reg, moves } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    reg.claim('n1', LANE, LOWER);
    reg.retract('n1');
    expect(e.parent, 'the surface component removes its DOM from where it PUT it').toBe('park');
    expect(moves.at(-1)).toBe('park:canvas->park');
    expect(reg.peek('n1')).toBeNull();
  });

  it('a retract with nothing claimed moves nothing', () => {
    const { reg, moves } = harness();
    reg.publish('n1', el(), PARK);
    reg.retract('n1');
    expect(moves).toEqual([]);
  });

  it('a claim released AFTER a retract cannot throw or move a forgotten element', () => {
    const { reg } = harness();
    const e = el();
    reg.publish('n1', e, PARK);
    const c = reg.claim('n1', LANE, LOWER);
    reg.retract('n1');
    expect(() => c.release()).not.toThrow();
    expect(e.parent).toBe('park');
  });
});

describe('node-viz-surface-registry — the per-frame listeners', () => {
  it('emitFrame calls every listener for THAT node and no other', () => {
    const { reg } = harness();
    let a = 0;
    let b = 0;
    let other = 0;
    reg.onFrame('n1', () => a++);
    reg.onFrame('n1', () => b++);
    reg.onFrame('n2', () => other++);
    reg.emitFrame('n1');
    expect([a, b, other]).toEqual([1, 1, 0]);
  });

  it('unsubscribing stops the callback — a viewer that unmounts stops polling', () => {
    const { reg } = harness();
    let n = 0;
    const off = reg.onFrame('n1', () => n++);
    reg.emitFrame('n1');
    off();
    reg.emitFrame('n1');
    expect(n).toBe(1);
  });

  it('⚠ A THROWING LISTENER CANNOT STOP THE RENDER IT RIDES', () => {
    // The poll is a VIEW concern riding a PRODUCER's frame. An exception in one
    // one camera read must not take out `video_out` for the whole rack.
    const { reg } = harness();
    let reached = 0;
    reg.onFrame('n1', () => {
      throw new Error('boom');
    });
    reg.onFrame('n1', () => reached++);
    expect(() => reg.emitFrame('n1')).not.toThrow();
    expect(reached).toBe(1);
  });

  it('a listener that unsubscribes ITSELF mid-frame does not skip the next one', () => {
    const { reg } = harness();
    let second = 0;
    const off = reg.onFrame('n1', () => off());
    reg.onFrame('n1', () => second++);
    reg.emitFrame('n1');
    expect(second).toBe(1);
  });

  it('emitFrame on a node nobody listens to is a no-op, not a throw', () => {
    const { reg } = harness();
    expect(() => reg.emitFrame('nobody')).not.toThrow();
  });
});

describe('node-viz-surfaces — the ROSTER and the HOST agree in both directions', () => {
  // The `.ts` roster is the truth and
  // the `.svelte` host holds the component map, so neither file can name a
  // module the other does not.
  const HOST_SRC = readFileSync(
    fileURLToPath(new URL('./NodeVizSurfaceHost.svelte', import.meta.url)),
    'utf8',
  );

  it('every roster member has a component in the host map', () => {
    for (const p of VIZ_SURFACE_PRODUCERS) {
      expect(
        new RegExp(`\\b${p.type}\\s*:\\s*[A-Z][A-Za-z0-9_]*\\s*,`).test(HOST_SRC),
        `${p.type} is in VIZ_SURFACE_PRODUCERS but has no entry in HOST_SURFACES — the node ` +
          'would render an empty park and the module would ship BLACK',
      ).toBe(true);
    }
  });

  it('every host-map entry is a roster member AND a directly imported .svelte component', () => {
    const map = /const HOST_SURFACES[^=]*=\s*\{([\s\S]*?)\};/.exec(HOST_SRC);
    expect(map, 'could not parse HOST_SURFACES — has the shape changed?').not.toBeNull();
    const entries = [...map![1]!.matchAll(/(\w+)\s*:\s*([A-Z][A-Za-z0-9_]*)/g)];
    expect(entries.length, 'HOST_SURFACES parsed EMPTY — refusing to pass vacuously')
      .toBeGreaterThan(0);
    for (const [, type, component] of entries) {
      expect(
        NODE_VIZ_SURFACE_TYPES.has(type!),
        `HOST_SURFACES names '${type}', which is not in VIZ_SURFACE_PRODUCERS — Canvas would ` +
          'never render a host for it, so the entry is inert',
      ).toBe(true);
      // A surface has no registry-side name to derive, so the COMPONENT
      // identifier has to be pinned to a real import — the same check
      // `group-viz-hosts.test.ts` makes for the same reason.
      expect(
        new RegExp(`import\\s+${component}\\s+from\\s+'[^']+\\.svelte'`).test(HOST_SRC),
        `${component} is not a direct .svelte import in the host`,
      ).toBe(true);
    }
  });

  it('the host mounts the surface with NO ownsVideoOut override — one owner by construction', () => {
    // ⚠ THE PROP STILL EXISTS ON THE SURFACE (its bytes are pinned by the WebGL
    // attest basis) and nothing may pass it FALSE here: the node host is the
    // only mount, so it must be the one that installs the frame drawer and the
    // DRS step seam. A `false` here would leave the module with no drawer at
    // all, and `wavesculpt.ts`'s own drawFrame fills solid black.
    //
    // ⚠ PROP-SHAPED, NOT NAME-SHAPED — the trap the scope extraction walked
    // into and wrote down: this matches RAW source, so a comment that NAMES the
    // prop would satisfy a bare `/ownsVideoOut/` and the host's own explanation
    // of why it does not pass it would fail the check. Match the ASSIGNMENT.
    expect(/ownsVideoOut\s*=/.test(HOST_SRC), 'the host must not pass ownsVideoOut at all')
      .toBe(false);
    // ...and the negative control on THAT: a prop pass really would be caught.
    expect(/ownsVideoOut\s*=/.test('<Surface {nodeId} ownsVideoOut={false} />')).toBe(true);
  });
});

describe('onWinner — how the host learns the claimant KIND without importing a view (cube)', () => {
  // ⚠ WHY THIS SEAM EXISTS: wavesculpt's views show one canvas at ONE size, so
  // the claims only decide WHERE it shows. cube's two historical views mounted the
  // same attest-pinned renderer at DIFFERENT sizes (320×260 vs 300×210+orbit),
  // so the host re-mounts per WINNING KIND — and the claims already carry the
  // kind as priority. These legs own the delivery contract; the host's use of
  // it is `card-producer-lifetime.spec.ts`'s to prove on real DOM.

  it('delivers the CURRENT winner immediately on subscribe — including null', () => {
    const { reg } = harness();
    const seen: Array<number | null> = [];
    reg.publish('n1', el(), PARK);
    const off = reg.onWinner('n1', (p) => seen.push(p));
    expect(seen, 'no claim yet — the host must learn that too').toEqual([null]);
    off();
    reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
    const late: Array<number | null> = [];
    reg.onWinner('n1', (p) => late.push(p));
    expect(late, 'a late subscriber learns the standing winner, not a replay of history')
      .toEqual([VIZ_CLAIM_PRIORITY.dock]);
  });

  it('fires on every winner MOVE and stays silent on churn that keeps the winner', () => {
    const { reg } = harness();
    const seen: Array<number | null> = [];
    reg.publish('n1', el(), PARK);
    reg.onWinner('n1', (p) => seen.push(p));
    const lane = reg.claim('n1', LANE, LOWER);
    const dock = reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
    // A SECOND lower claim while the dock holds the picture changes nothing.
    const lane2 = reg.claim('n1', { id: 'lane2' }, LOWER);
    dock.release();
    lane.release();
    lane2.release();
    expect(seen).toEqual([
      null,
      LOWER,
      VIZ_CLAIM_PRIORITY.dock,
      // lane2's arrival: silent (dock still wins). dock release → lane wins
      // (lane2 is the most recent same-priority claim, same NUMBER — no move).
      LOWER,
      // lane's release: lane2 still stands at the same priority — silent.
      null,
    ]);
  });

  it('a listener that THROWS does not stop delivery, and retract/publish alone notify nobody', () => {
    const { reg } = harness();
    const seen: Array<number | null> = [];
    reg.publish('n1', el(), PARK);
    reg.onWinner('n1', () => {
      throw new Error('remount handler exploded');
    });
    reg.onWinner('n1', (p) => seen.push(p));
    reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock);
    expect(seen).toEqual([null, VIZ_CLAIM_PRIORITY.dock]);
    // The host's own remount does retract→publish; claims did not change, so
    // the winner must not re-fire — that loop would remount forever.
    reg.retract('n1');
    reg.publish('n1', el(), PARK);
    expect(seen).toEqual([null, VIZ_CLAIM_PRIORITY.dock]);
  });

  it('unsubscribe stops delivery and lets the entry prune with the rest', () => {
    const { reg } = harness();
    const seen: Array<number | null> = [];
    const off = reg.onWinner('n1', (p) => seen.push(p));
    off();
    reg.claim('n1', DOCK, VIZ_CLAIM_PRIORITY.dock).release();
    expect(seen, 'only the immediate delivery, nothing after unsubscribe').toEqual([null]);
    expect(reg.snapshot(), 'nothing left to remember').toEqual([]);
  });
});
