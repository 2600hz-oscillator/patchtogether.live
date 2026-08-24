// packages/web/src/lib/ui/media/loopback-crop-pump.test.ts
//
// The NODE-KEYED crop pump, driven as a unit — including the viewport pick that
// the old card-local `document.querySelector('.svelte-flow')` got right only by
// markup order.
//
// ⚠ WHY THE PICK NEEDS A TEST AT ALL, stated because "it obviously picks the
// canvas" is exactly what the old reader looked like: `<HeadlessSourceHost>`
// mounts every hosted card inside its OWN `<SvelteFlow>`, and loopback is a
// DOM-source module, so a second `.svelte-flow` is in the document whenever the
// shell renders a placeholder OR a face for it — which is every default-shell
// rack, today and after the promotion. If the pick ever lands on the host, the
// measured rect is `{ x: -9999, w: 300, h: 420 }`, `computeCropUv` clamps that
// to a collapsed region and falls back to FULL FRAME, and the symptom is "the
// Crop control silently does nothing" with no error anywhere.

import { describe, it, expect, vi } from 'vitest';

import {
  createLoopbackCropPumpRegistry,
  pickCanvasViewport,
  loopbackCropPump,
  HEADLESS_HOST_SELECTOR,
  FLOW_ROOT_SELECTOR,
  type CropPumpDeps,
} from './loopback-crop-pump';
import { FULL_FRAME_CROP, computeCropUv } from '$lib/video/loopback-crop';

/** A stand-in for a flow root. `closest` is the only DOM surface the pick uses,
 *  which is why the predicate takes it structurally — this package's vitest is
 *  `environment: 'node'` and there is no jsdom to lean on. */
function flow(opts: { hosted: boolean; name: string }) {
  return {
    name: opts.name,
    closest(selector: string) {
      return opts.hosted && selector === HEADLESS_HOST_SELECTOR ? { host: true } : null;
    },
  };
}

/** A manual frame clock, so "one frame" is a thing the test performs rather
 *  than a thing it waits for. */
function manualRaf() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => {
      const h = next++;
      queue.set(h, fn);
      return h;
    },
    cancel: (h: number) => {
      queue.delete(h);
    },
    /** Run every currently-queued callback once. */
    tick(): void {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    get pending(): number {
      return queue.size;
    },
  };
}

function deps(over: Partial<CropPumpDeps> = {}): CropPumpDeps {
  return {
    push: vi.fn(),
    cropEnabled: () => true,
    measure: () => ({
      rect: { x: 100, y: 50, width: 800, height: 400 },
      viewportW: 1000,
      viewportH: 500,
    }),
    ...over,
  };
}

describe('pickCanvasViewport — the REAL canvas, never a headless host copy', () => {
  it('rejects a hosted flow and takes the canvas even when the host comes FIRST', () => {
    // ⚠ THE ORDER IS THE POINT. `querySelector` would return the host here, and
    // the old reader depended on document order putting the canvas first. This
    // is the case that separates "it works" from "it happens to work".
    const host = flow({ hosted: true, name: 'host' });
    const canvas = flow({ hosted: false, name: 'canvas' });
    expect(pickCanvasViewport([host, canvas])?.name).toBe('canvas');
  });

  it('takes the canvas when it comes first, too', () => {
    const canvas = flow({ hosted: false, name: 'canvas' });
    const host = flow({ hosted: true, name: 'host' });
    expect(pickCanvasViewport([canvas, host])?.name).toBe('canvas');
  });

  it('returns NULL when every candidate is hosted — a real answer, not a wrong element', () => {
    // The caller must be able to fall back deliberately. Returning the host
    // would be the silent-wrong-answer this whole file exists to prevent.
    expect(pickCanvasViewport([flow({ hosted: true, name: 'a' }), flow({ hosted: true, name: 'b' })])).toBeNull();
  });

  it('returns NULL for an empty candidate list', () => {
    expect(pickCanvasViewport([])).toBeNull();
  });

  it('NEGATIVE CONTROL: the rejection really keys on the HOST selector, not on any ancestor', () => {
    // An element inside some other wrapper must still be accepted — a predicate
    // that rejected everything would satisfy the "returns null" legs above and
    // would silently disable the crop entirely.
    const inSomethingElse = {
      name: 'canvas-in-a-panel',
      closest: (s: string) => (s === '.some-other-wrapper' ? {} : null),
    };
    expect(pickCanvasViewport([inSomethingElse])?.name).toBe('canvas-in-a-panel');
  });

  it('the selectors it queries and rejects are the ones the markup actually uses', () => {
    // Anchored so a class rename in HeadlessSourceHost.svelte cannot leave this
    // predicate quietly matching nothing.
    expect(FLOW_ROOT_SELECTOR).toBe('.svelte-flow');
    expect(HEADLESS_HOST_SELECTOR).toBe('.headless-source-host');
  });
});

describe('loopback-crop-pump — the loop', () => {
  it('pushes a crop derived from the measured viewport, every frame', () => {
    const raf = manualRaf();
    const push = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    r.start('n1', deps({ push, schedule: raf.schedule, cancel: raf.cancel }));

    raf.tick();
    expect(push).toHaveBeenCalledTimes(1);
    const pushed = push.mock.calls[0]![0];

    // ⚠ COMPARED AGAINST THE PURE FUNCTION, NOT AGAINST RE-TYPED NUMBERS. The
    // first draft hand-computed `v0: 0.1` and failed on `0.09999999999999998`
    // — `1 - 0.9` in binary floating point. Re-typing the arithmetic would have
    // meant a second copy of the crop math living in a test, which is the thing
    // `loopback-crop.ts` exists to prevent; the pump's actual contract is that
    // it pushes exactly what `computeCropUv` returns for the measurement it
    // took, so that is what is asserted.
    expect(pushed).toEqual(
      computeCropUv({ x: 100, y: 50, width: 800, height: 400 }, 1000, 500),
    );

    // ...and INDEPENDENTLY, the landmark values a reader expects, so the leg
    // above cannot pass by both sides being wrong in the same way. rect
    // x=100/1000 → u0 0.1; (100+800)/1000 → u1 0.9. The vertical axis flips for
    // the UNPACK_FLIP_Y upload: bottom edge (50+400)/500 = 0.9 → v0 = 0.1; top
    // edge 50/500 = 0.1 → v1 = 0.9.
    expect(pushed.u0).toBeCloseTo(0.1, 10);
    expect(pushed.u1).toBeCloseTo(0.9, 10);
    expect(pushed.v0, 'the FLIP — the element top becomes max v').toBeCloseTo(0.1, 10);
    expect(pushed.v1).toBeCloseTo(0.9, 10);

    raf.tick();
    expect(push, 'the pump keeps going — the viewport moves under it').toHaveBeenCalledTimes(2);
  });

  it('RE-READS the crop toggle every frame instead of latching it', () => {
    // The stuck-value shape this move exists to remove: a value hoisted out of
    // the tick closure stops tracking, and the picture stays live so nothing
    // looks broken.
    const raf = manualRaf();
    const push = vi.fn();
    let enabled = true;
    const r = createLoopbackCropPumpRegistry();
    r.start('n1', deps({ push, cropEnabled: () => enabled, schedule: raf.schedule, cancel: raf.cancel }));

    raf.tick();
    expect(push.mock.calls[0]![0]).not.toEqual(FULL_FRAME_CROP);

    enabled = false;
    raf.tick();
    expect(push.mock.calls[1]![0], 'crop OFF ⇒ the whole tab').toEqual(FULL_FRAME_CROP);

    enabled = true;
    raf.tick();
    expect(push.mock.calls[2]![0], 'and back again').not.toEqual(FULL_FRAME_CROP);
  });

  it('falls back to the FULL FRAME when the viewport cannot be measured', () => {
    const raf = manualRaf();
    const push = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    r.start('n1', deps({ push, measure: () => null, schedule: raf.schedule, cancel: raf.cancel }));
    raf.tick();
    expect(push.mock.calls[0]![0]).toEqual(FULL_FRAME_CROP);
  });

  it('a THROWING push never kills the loop', () => {
    // The engine can be torn down mid-frame. A dead pump would freeze the crop
    // for the rest of the capture with no error surfacing anywhere.
    const raf = manualRaf();
    const r = createLoopbackCropPumpRegistry();
    r.start('n1', deps({
      push: () => { throw new Error('engine gone'); },
      schedule: raf.schedule,
      cancel: raf.cancel,
    }));
    expect(() => raf.tick()).not.toThrow();
    expect(r.running('n1'), 'still scheduled for the next frame').toBe(true);
    expect(r.ticks('n1'), 'and it counted the frame it survived').toBe(1);
  });
});

describe('loopback-crop-pump — NODE lifetime, not card lifetime', () => {
  it('start is IDEMPOTENT while running — a card remount cannot stack a second loop', () => {
    // Two loops would both push every frame: double the engine writes, and a
    // stop that only cancels one leaves the other running forever.
    const raf = manualRaf();
    const push = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    const d = deps({ push, schedule: raf.schedule, cancel: raf.cancel });
    r.start('n1', d);
    r.start('n1', d);
    r.start('n1', d);
    raf.tick();
    expect(push, 'one pump, one push per frame').toHaveBeenCalledTimes(1);
    expect(raf.pending, 'exactly one frame is queued').toBe(1);
  });

  it('stop() ends the loop and is idempotent', () => {
    const raf = manualRaf();
    const push = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    r.start('n1', deps({ push, schedule: raf.schedule, cancel: raf.cancel }));
    raf.tick();
    r.stop('n1');
    r.stop('n1');
    raf.tick();
    expect(push, 'no further pushes after the stop').toHaveBeenCalledTimes(1);
    expect(r.running('n1')).toBe(false);
  });

  it('a stopped pump can be RESTARTED, and its tick count carries across', () => {
    // ⚠ THE TICK COUNT IS THE ONLY OBSERVABLE THIS THING HAS — the pump writes
    // to a PRIVATE param channel `readParam` does not expose and nothing in the
    // graph mirrors, so "it ran" and "it was never started" are otherwise
    // indistinguishable from outside. It must survive a stop, or a test cannot
    // assert a pump DID run before teardown.
    const raf = manualRaf();
    const r = createLoopbackCropPumpRegistry();
    const d = deps({ schedule: raf.schedule, cancel: raf.cancel });
    r.start('n1', d);
    raf.tick();
    r.stop('n1');
    expect(r.ticks('n1')).toBe(1);
    r.start('n1', d);
    raf.tick();
    expect(r.ticks('n1')).toBe(2);
  });

  it('keeps nodes independent', () => {
    const raf = manualRaf();
    const a = vi.fn();
    const b = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    r.start('a', deps({ push: a, schedule: raf.schedule, cancel: raf.cancel }));
    r.start('b', deps({ push: b, schedule: raf.schedule, cancel: raf.cancel }));
    raf.tick();
    r.stop('a');
    raf.tick();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b, 'stopping a must not stop b').toHaveBeenCalledTimes(2);
  });

  it('sweep() ends the pump for a node the GRAPH no longer has', () => {
    // ⚠ THE ONLY THING THAT EVER STOPS A DELETED NODE'S PUMP. It is node-keyed
    // and deliberately survives a card unmount, so a card teardown cannot be
    // what ends it — without the Canvas sweep a deleted loopback would leave a
    // rAF loop measuring the viewport forever.
    const raf = manualRaf();
    const gone = vi.fn();
    const live = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    r.start('gone', deps({ push: gone, schedule: raf.schedule, cancel: raf.cancel }));
    r.start('live', deps({ push: live, schedule: raf.schedule, cancel: raf.cancel }));
    raf.tick();
    r.sweep(['live']);
    raf.tick();
    expect(gone).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledTimes(2);
    expect(r.running('gone')).toBe(false);
    expect(r.running('live')).toBe(true);
  });

  it('sweep survives being DESTRUCTURED off the registry (no `this` dependency)', () => {
    const raf = manualRaf();
    const r = createLoopbackCropPumpRegistry();
    r.start('gone', deps({ schedule: raf.schedule, cancel: raf.cancel }));
    const { sweep } = r;
    expect(() => sweep([])).not.toThrow();
    expect(r.running('gone')).toBe(false);
  });

  it('NEGATIVE CONTROL: sweep with everything live stops nothing', () => {
    const raf = manualRaf();
    const push = vi.fn();
    const r = createLoopbackCropPumpRegistry();
    r.start('a', deps({ push, schedule: raf.schedule, cancel: raf.cancel }));
    r.sweep(['a']);
    raf.tick();
    expect(r.running('a')).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a node it has never seen', () => {
    const r = createLoopbackCropPumpRegistry();
    expect(r.running('never')).toBe(false);
    expect(r.ticks('never')).toBe(0);
  });
});

describe('loopback-crop-pump — the singleton', () => {
  it('exports a live registry the card starts and Canvas sweeps', () => {
    const raf = manualRaf();
    const push = vi.fn();
    loopbackCropPump.start('singleton-probe', deps({ push, schedule: raf.schedule, cancel: raf.cancel }));
    raf.tick();
    expect(loopbackCropPump.running('singleton-probe')).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    loopbackCropPump.sweep([]);
    expect(loopbackCropPump.running('singleton-probe')).toBe(false);
  });
});
