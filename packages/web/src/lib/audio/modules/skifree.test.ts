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
  skifreeDef,
  cvToCanvasCoord,
  SKIFREE_CANVAS_SIZE,
  SKIFREE_GATE_PULSE_S,
} from './skifree';

describe('skifree module def', () => {
  it('exposes the expected IO surface', () => {
    expect(skifreeDef.type).toBe('skifree');
    expect(skifreeDef.domain).toBe('audio');
    expect(skifreeDef.label).toBe('SKIFREE');
    expect(skifreeDef.category).toBe('games');
    expect(skifreeDef.maxInstances).toBe(1);
    expect(skifreeDef.vizPassthrough).toBe(true);
    expect(skifreeDef.params.length).toBe(0);

    // Inputs: x / y CV (the synthesized cursor the skier steers toward).
    const inputIds = skifreeDef.inputs.map((p) => p.id).sort();
    expect(inputIds).toEqual(['x', 'y']);
    for (const p of skifreeDef.inputs) expect(p.type).toBe('cv');

    // Outputs: gate (crash/eaten) + out (video canvas).
    const gate = skifreeDef.outputs.find((p) => p.id === 'gate');
    const out = skifreeDef.outputs.find((p) => p.id === 'out');
    expect(gate, 'skifree must expose a `gate` output').toBeDefined();
    expect(gate!.type).toBe('gate');
    expect(out, 'skifree must expose an `out` video output').toBeDefined();
    expect(out!.type).toBe('video');
  });

  it('declares attribution to the upstream skifree.js (MIT)', () => {
    expect(skifreeDef.ossAttribution?.author).toContain('skifree.js');
    expect(skifreeDef.ossAttribution?.author).toContain('MIT');
  });
});

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
