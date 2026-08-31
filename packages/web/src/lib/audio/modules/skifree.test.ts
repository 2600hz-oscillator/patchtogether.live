// packages/web/src/lib/audio/modules/skifree.test.ts
//
// Unit tests for the SKIFREE module def, the pure CV→cursor mapping, and
// the committed bundle's crash/eaten → gate hook. The vitest environment is
// `node`, so the bundle test installs minimal DOM stubs (no real 2D context
// is needed — the engine's draw calls are no-ops here; we exercise the
// state + gate-callback path the audio factory depends on).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cvToCanvasCoord,
  pointerToCanvasCoord,
  SKIFREE_CANVAS_SIZE,
  SKIFREE_GATE_PULSE_S,
} from './skifree';

describe('cvToCanvasCoord — CV → cursor mapping', () => {
  it('maps CV 0 to the canvas centre (skier straight down)', () => {
    expect(cvToCanvasCoord(0, 320)).toBe(160);
    expect(cvToCanvasCoord(0)).toBe(SKIFREE_CANVAS_SIZE / 2);
  });

  it('maps CV -1 / +1 to the canvas edges', () => {
    expect(cvToCanvasCoord(-1, 320)).toBe(0);
    expect(cvToCanvasCoord(1, 320)).toBe(320);
  });

  it('maps mid-range CV linearly', () => {
    expect(cvToCanvasCoord(-0.5, 320)).toBe(80);
    expect(cvToCanvasCoord(0.5, 320)).toBe(240);
  });

  it('clamps out-of-range CV to the canvas bounds', () => {
    expect(cvToCanvasCoord(-5, 320)).toBe(0);
    expect(cvToCanvasCoord(5, 320)).toBe(320);
  });

  it('respects a custom canvas size', () => {
    expect(cvToCanvasCoord(0, 640)).toBe(320);
    expect(cvToCanvasCoord(1, 640)).toBe(640);
  });
});

// ── THE POINTER → CURSOR MAP ────────────────────────────────────────────────
//
// ⚠ THIS BLOCK IS THE UNIT-LEVEL RECORD OF A SHIPPING DEFECT, not a new
// helper's happy path. Until this PR both surfaces called
// `controller.enableMouse(el)`, whose handlers do `e.clientX - rect.left`
// against the canvas the FACTORY owns — which #2192 made DETACHED by design, so
// `getBoundingClientRect()` returns all zeros. Every field being 0 means the
// subtraction is the identity: the cursor received raw VIEWPORT coordinates in
// a 0..320 space, so a pointer anywhere right of x=320 pinned the skier to the
// right edge and "steering" was one stuck direction.
//
// Two properties fix it and both are asserted here: the map is a RATIO of the
// displayed element (which is 320 CSS px in the dock and 104 on the lane tile,
// so a subtraction could never have been right at BOTH tiers), and an
// unmeasurable element returns the RESTING CENTRE rather than a number in the
// wrong units.
describe('pointerToCanvasCoord — pointer → cursor mapping', () => {
  it('maps the rect ratio, not the raw offset — the DOCK tier at 320 CSS px', () => {
    // A 320 px picture whose left edge is 500 px into the viewport.
    expect(pointerToCanvasCoord(500, 500, 320)).toBe(0);
    expect(pointerToCanvasCoord(660, 500, 320)).toBe(160);
    expect(pointerToCanvasCoord(820, 500, 320)).toBe(320);
  });

  it('⚠ and the SAME centre lands at the LANE tier, where the sizes differ', () => {
    // 104 CSS px, the tile body's size. A subtraction would read 52 here and
    // 160 in the dock for the same GESTURE, which is what makes the ratio
    // load-bearing rather than stylistic.
    expect(pointerToCanvasCoord(552, 500, 104)).toBe(SKIFREE_CANVAS_SIZE / 2);
    expect(pointerToCanvasCoord(500, 500, 104)).toBe(0);
    expect(pointerToCanvasCoord(604, 500, 104)).toBe(SKIFREE_CANVAS_SIZE);
  });

  it('clamps a pointer outside the element to the canvas bounds', () => {
    expect(pointerToCanvasCoord(100, 500, 320)).toBe(0);
    expect(pointerToCanvasCoord(9000, 500, 320)).toBe(320);
  });

  it('⚠ THE DEFECT ITSELF: a ZERO-SIZED rect returns the CENTRE, never the raw client px', () => {
    // The detached-canvas rect, verbatim: every field 0. The bundle's handler
    // computed `900 - 0 = 900` and wrote it into a 0..320 space.
    expect(pointerToCanvasCoord(900, 0, 0)).toBe(SKIFREE_CANVAS_SIZE / 2);
    expect(pointerToCanvasCoord(900, 0, 0)).not.toBe(900);
    // …and the same for a negative or NaN width, which no real element has but
    // a stale measurement can produce.
    expect(pointerToCanvasCoord(900, 0, -5)).toBe(SKIFREE_CANVAS_SIZE / 2);
    expect(pointerToCanvasCoord(900, 0, Number.NaN)).toBe(SKIFREE_CANVAS_SIZE / 2);
  });

  it('agrees with cvToCanvasCoord at the resting cursor — one coordinate space, two inputs', () => {
    // The CV path and the MOUSE path write the SAME `setCursor`, so "centre"
    // must mean the same thing to both. They are exported from one file for
    // this reason.
    expect(pointerToCanvasCoord(660, 500, 320)).toBe(cvToCanvasCoord(0));
  });

  it('respects a custom canvas size', () => {
    expect(pointerToCanvasCoord(660, 500, 320, 640)).toBe(320);
  });
});

describe('committed bundle (static/skifree/skifree.bundle.js)', () => {
  it('exists + assigns window.SkiFree', () => {
    const bundlePath = path.resolve(
      __dirname, '../../../../static/skifree/skifree.bundle.js',
    );
    expect(fs.existsSync(bundlePath), `bundle missing at ${bundlePath}`).toBe(true);
    const code = fs.readFileSync(bundlePath, 'utf8');
    // The embed assigns window.SkiFree (the card's <script>-tag load path).
    expect(code).toContain('SkiFree');
    expect(code.length).toBeGreaterThan(1000);
  });

  it('sprite sheets are committed alongside the bundle', () => {
    const base = path.resolve(__dirname, '../../../../static/skifree');
    expect(fs.existsSync(path.join(base, 'sprite-characters.png'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'skifree-objects.png'))).toBe(true);
  });
});

describe('bundle controller — crash/eaten → onGate hook', () => {
  // Minimal DOM stubs so the bundle's game classes run in the node env. The
  // 2D context methods are no-ops (drawing isn't under test); the gate path
  // is driven via the controller's _forceCrash / _forceEaten test hooks.
  let savedGlobals: Record<string, unknown> = {};
  let controller: {
    setCursor(x: number, y: number): void;
    getState(): { crashes: number; eaten: number; lastEvent: string | null };
    _forceCrash(): void;
    _forceEaten(): void;
    dispose(): void;
  };
  let gates: Array<{ type: string }>;

  beforeEach(() => {
    gates = [];
    savedGlobals = {
      requestAnimationFrame: (globalThis as Record<string, unknown>).requestAnimationFrame,
      cancelAnimationFrame: (globalThis as Record<string, unknown>).cancelAnimationFrame,
      Image: (globalThis as Record<string, unknown>).Image,
      localStorage: (globalThis as Record<string, unknown>).localStorage,
      SkiFree: (globalThis as Record<string, unknown>).SkiFree,
    };

    class FakeCtx {
      canvas: unknown;
      _font = '11px monospace';
      constructor(canvas: unknown) { this.canvas = canvas; }
      scale() {} clearRect() {} drawImage() {} fillText() {}
      measureText() { return { width: 10 }; }
      set font(v: string) { this._font = v; }
      get font() { return this._font; }
      set fillStyle(_v: string) {}
      set imageSmoothingEnabled(_v: boolean) {}
    }
    class FakeCanvas {
      style: Record<string, string> = {};
      width = 0; height = 0;
      getContext() { return new FakeCtx(this); }
      getBoundingClientRect() { return { left: 0, top: 0 }; }
      addEventListener() {} removeEventListener() {}
    }

    (globalThis as Record<string, unknown>).requestAnimationFrame = () => 0;
    (globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: () => null, setItem: () => {},
    };
    // Images "load" synchronously-ish so buildGame runs.
    (globalThis as Record<string, unknown>).Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { if (this.onload) queueMicrotask(() => this.onload && this.onload()); }
    };

    // Load the committed bundle into this realm (it assigns window.SkiFree).
    const bundlePath = path.resolve(
      __dirname, '../../../../static/skifree/skifree.bundle.js',
    );
    const code = fs.readFileSync(bundlePath, 'utf8');
    // window === globalThis in node-test (no jsdom); the bundle's
    // `if (typeof window !== 'undefined') window.SkiFree = ...` then
    // assigns onto globalThis.
    (globalThis as Record<string, unknown>).window = globalThis;
    // eslint-disable-next-line no-eval
    (0, eval)(code);

    const SkiFree = (globalThis as Record<string, unknown>).SkiFree as {
      create(opts: unknown): typeof controller;
    };
    controller = SkiFree.create({
      canvas: new FakeCanvas(),
      width: 320,
      height: 320,
      onGate: (e: { type: string }) => gates.push(e),
    });
  });

  afterEach(() => {
    try { controller?.dispose(); } catch { /* */ }
    for (const [k, v] of Object.entries(savedGlobals)) {
      (globalThis as Record<string, unknown>)[k] = v;
    }
  });

  it('fires a `crash` gate when the skier hits an obstacle', async () => {
    await Promise.resolve(); // let images "load"
    controller._forceCrash();
    expect(gates.length).toBe(1);
    expect(gates[0]!.type).toBe('crash');
    expect(controller.getState().crashes).toBe(1);
    expect(controller.getState().lastEvent).toBe('crash');
  });

  it('fires an `eaten` gate when the yeti catches the skier', async () => {
    await Promise.resolve();
    controller._forceEaten();
    expect(gates.length).toBe(1);
    expect(gates[0]!.type).toBe('eaten');
    expect(controller.getState().eaten).toBe(1);
    expect(controller.getState().lastEvent).toBe('eaten');
  });

  it('setCursor does not throw + the controller exposes the canvas', async () => {
    await Promise.resolve();
    expect(() => controller.setCursor(200, 100)).not.toThrow();
    expect((controller as unknown as { canvas: unknown }).canvas).toBeDefined();
  });
});

describe('gate pulse width constant', () => {
  it('matches the project gate convention (10 ms)', () => {
    expect(SKIFREE_GATE_PULSE_S).toBeCloseTo(0.01);
  });
});
