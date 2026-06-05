// packages/web/src/lib/video/toybox-shadertoy.test.ts
//
// Pure-helper coverage for the Shadertoy runtime seam:
//   - mainImage → main shim + uniform injection,
//   - iMouse client→engine coord mapping (Y-flip) + .z/.w press state machine,
//   - multi-buffer pass topo-ordering (producers first, Image last),
//   - channel resolution.

import { describe, it, expect } from 'vitest';
import {
  isShadertoySource,
  wrapShadertoySource,
  SHADERTOY_UNIFORM_BLOCK,
  canvasToEnginePx,
  makeMouseState,
  mouseDown,
  mouseMove,
  mouseUp,
  mouseToVec4,
  topoOrderPasses,
  resolveChannels,
  isShadertoyProject,
  IMAGE_PASS_ID,
  type ShadertoyProject,
  type ShadertoyPass,
} from './toybox-shadertoy';

// ---------------- shim + uniforms ----------------

describe('Shadertoy source detection', () => {
  it('detects a mainImage source', () => {
    expect(isShadertoySource('void mainImage( out vec4 fragColor, in vec2 fragCoord ){}')).toBe(true);
    expect(isShadertoySource('void mainImage(out vec4 c, in vec2 f){}')).toBe(true);
  });
  it('rejects an engine-convention main() source', () => {
    expect(isShadertoySource('void main(){ outColor = vec4(1.0); }')).toBe(false);
  });
});

describe('wrapShadertoySource', () => {
  const body = 'void mainImage(out vec4 fragColor, in vec2 fragCoord){ fragColor = vec4(fragCoord/iResolution.xy, 0.0, 1.0); }';

  it('produces a #version 300 es main() shim that calls mainImage with gl_FragCoord', () => {
    const out = wrapShadertoySource(body);
    expect(out.startsWith('#version 300 es')).toBe(true);
    expect(out).toContain('void main()');
    expect(out).toContain('mainImage(_c, gl_FragCoord.xy)');
    expect(out).toContain('_stFragColor = _c');
    // The original body is present verbatim.
    expect(out).toContain('void mainImage(out vec4 fragColor, in vec2 fragCoord)');
  });

  it('injects the full Shadertoy uniform set', () => {
    const out = wrapShadertoySource(body);
    expect(out).toContain(SHADERTOY_UNIFORM_BLOCK);
    for (const u of [
      'uniform vec3      iResolution',
      'uniform float     iTime',
      'uniform float     iTimeDelta',
      'uniform float     iFrameRate',
      'uniform int       iFrame',
      'uniform vec4      iMouse',
      'uniform vec4      iDate',
      'uniform sampler2D iChannel0',
      'uniform sampler2D iChannel3',
      'uniform vec3      iChannelResolution[4]',
    ]) {
      expect(out).toContain(u);
    }
  });

  it('prepends the Common chunk ahead of the body', () => {
    const out = wrapShadertoySource(body, '#define FOO 1.0\nfloat helper(){ return FOO; }');
    const commonIdx = out.indexOf('float helper()');
    const bodyIdx = out.indexOf('void mainImage');
    expect(commonIdx).toBeGreaterThan(0);
    expect(commonIdx).toBeLessThan(bodyIdx); // common before body
  });

  it('strips a leading #version from the body and common (only one version header)', () => {
    const out = wrapShadertoySource('#version 300 es\n' + body, '#version 300 es\nfloat c(){return 0.0;}');
    expect((out.match(/#version/g) ?? []).length).toBe(1);
  });

  it('emits a uniform float for each declared content param', () => {
    const out = wrapShadertoySource(body, '', ['amount', 'split']);
    expect(out).toContain('uniform float amount;');
    expect(out).toContain('uniform float split;');
  });

  it('skips param names that collide with a Shadertoy uniform or are malformed', () => {
    const out = wrapShadertoySource(body, '', ['iTime', '9bad', 'good']);
    // iTime is declared by the uniform block — NOT re-emitted as a param decl
    // (so it appears exactly once across the whole source).
    expect((out.match(/\biTime\b\s*;/g) ?? []).length).toBe(1);
    expect(out).not.toContain('uniform float 9bad;');
    expect(out).toContain('uniform float good;');
  });
});

// ---------------- iMouse coord mapping ----------------

describe('canvasToEnginePx', () => {
  const rect = { x: 10, y: 5, w: 200, h: 150 };
  const W = 640;
  const H = 480;

  it('maps the top-left of the drawn image to engine (0, H) [bottom-origin flip]', () => {
    const p = canvasToEnginePx(10, 5, rect, W, H);
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(0, 5);
    expect(p!.y).toBeCloseTo(H, 5); // top of canvas → top of engine = max y
  });

  it('maps the bottom-left of the drawn image to engine (0, 0)', () => {
    const p = canvasToEnginePx(10, 5 + 150, rect, W, H);
    expect(p!.x).toBeCloseTo(0, 5);
    expect(p!.y).toBeCloseTo(0, 5);
  });

  it('maps the centre to (W/2, H/2)', () => {
    const p = canvasToEnginePx(10 + 100, 5 + 75, rect, W, H);
    expect(p!.x).toBeCloseTo(W / 2, 3);
    expect(p!.y).toBeCloseTo(H / 2, 3);
  });

  it('returns null outside the letterboxed image area', () => {
    expect(canvasToEnginePx(0, 0, rect, W, H)).toBeNull(); // in the black bar
    expect(canvasToEnginePx(10 + 201, 5 + 75, rect, W, H)).toBeNull();
  });

  it('returns null for a zero-size rect', () => {
    expect(canvasToEnginePx(5, 5, { x: 0, y: 0, w: 0, h: 0 }, W, H)).toBeNull();
  });
});

// ---------------- iMouse state machine ----------------

describe('iMouse press state (Shadertoy .xy/.z/.w semantics)', () => {
  it('is all-zero before any interaction', () => {
    const s = makeMouseState();
    expect(mouseToVec4(s)).toEqual([0, 0, 0, 0]);
  });

  it('on press: .xy = pos, .z = +pressX, .w = +pressY (click frame)', () => {
    const s = makeMouseState();
    mouseDown(s, 100, 200);
    expect(mouseToVec4(s)).toEqual([100, 200, 100, 200]);
  });

  it('after the click frame (still held): .z stays +pressX, .w flips to -pressY', () => {
    const s = makeMouseState();
    mouseDown(s, 100, 200);
    mouseToVec4(s); // consume the click frame
    // Next frame, still down, no move:
    expect(mouseToVec4(s)).toEqual([100, 200, 100, -200]);
  });

  it('move while held updates .xy; hover (not held) is ignored', () => {
    const s = makeMouseState();
    mouseDown(s, 100, 200);
    mouseToVec4(s);
    mouseMove(s, 150, 250);
    expect(mouseToVec4(s)).toEqual([150, 250, 100, -200]);
    mouseUp(s);
    mouseMove(s, 999, 999); // hover ignored after release
    const v = mouseToVec4(s);
    expect(v[0]).toBe(150); // .xy held at last position
    expect(v[1]).toBe(250);
  });

  it('on release: .z flips to -pressX (and .w stays -pressY)', () => {
    const s = makeMouseState();
    mouseDown(s, 100, 200);
    mouseToVec4(s);
    mouseUp(s);
    expect(mouseToVec4(s)).toEqual([100, 200, -100, -200]);
  });

  it('a fresh press after release sets a NEW click frame', () => {
    const s = makeMouseState();
    mouseDown(s, 10, 20);
    mouseToVec4(s);
    mouseUp(s);
    mouseToVec4(s);
    mouseDown(s, 30, 40);
    expect(mouseToVec4(s)).toEqual([30, 40, 30, 40]); // .w positive again
  });
});

// ---------------- pass topo-ordering ----------------

function pass(id: string, channels: ShadertoyPass['channels'] = [], float = false): ShadertoyPass {
  return { id, src: `// ${id}`, channels, float };
}

describe('topoOrderPasses', () => {
  it('orders the Image pass last', () => {
    const proj: ShadertoyProject = { passes: [pass('image'), pass('bufferA')] };
    const order = topoOrderPasses(proj);
    expect(order[order.length - 1]).toBe(IMAGE_PASS_ID);
  });

  it('orders producers before consumers (A → B → image)', () => {
    // image samples B, B samples A.
    const proj: ShadertoyProject = {
      passes: [
        pass('image', [{ type: 'buffer', pass: 'bufferB' }]),
        pass('bufferB', [{ type: 'buffer', pass: 'bufferA' }]),
        pass('bufferA', []),
      ],
    };
    const order = topoOrderPasses(proj);
    expect(order.indexOf('bufferA')).toBeLessThan(order.indexOf('bufferB'));
    expect(order.indexOf('bufferB')).toBeLessThan(order.indexOf('image'));
  });

  it('treats a self-channel as NON-dependency (no cycle, no reorder requirement)', () => {
    const proj: ShadertoyProject = {
      passes: [pass('bufferA', [{ type: 'self' }]), pass('image', [{ type: 'buffer', pass: 'bufferA' }])],
    };
    const order = topoOrderPasses(proj);
    expect(order).toEqual(['bufferA', 'image']);
  });

  it('replicates the growing-peak topology (A self-feedback heightmap → image reads A)', () => {
    // The bundled 'growing-peak' preset (the original multi-buffer growable
    // terrain that replaced the erosion port): a float self-feedback heightmap
    // (Buffer A, ping-pong) read by the raymarched Image pass.
    const proj: ShadertoyProject = {
      passes: [
        pass('image', [{ type: 'buffer', pass: 'bufferA' }]),
        pass('bufferA', [{ type: 'self' }], true),
      ],
    };
    const order = topoOrderPasses(proj);
    expect(order.indexOf('bufferA')).toBeLessThan(order.indexOf('image'));
    expect(order[order.length - 1]).toBe('image');
    // every pass appears exactly once.
    expect(new Set(order).size).toBe(2);
    expect(order.length).toBe(2);
  });

  it('still orders a deeper multi-buffer chain (A self → B reads A → C → image reads B,C)', () => {
    // General multi-buffer runtime coverage beyond the bundled preset: producers
    // before consumers, Image last, across a 4-pass dependency graph.
    const proj: ShadertoyProject = {
      passes: [
        pass('image', [
          { type: 'buffer', pass: 'bufferB' },
          { type: 'buffer', pass: 'bufferC' },
          { type: 'buffer', pass: 'bufferC' },
        ]),
        pass('bufferA', [{ type: 'self' }, { type: 'keyboard' }], true),
        pass('bufferB', [{ type: 'buffer', pass: 'bufferA' }], true),
        pass('bufferC', []),
      ],
    };
    const order = topoOrderPasses(proj);
    expect(order.indexOf('bufferA')).toBeLessThan(order.indexOf('bufferB'));
    expect(order.indexOf('bufferB')).toBeLessThan(order.indexOf('image'));
    expect(order.indexOf('bufferC')).toBeLessThan(order.indexOf('image'));
    expect(order[order.length - 1]).toBe('image');
    expect(new Set(order).size).toBe(4);
    expect(order.length).toBe(4);
  });

  it('does not drop passes on a malformed non-self cycle', () => {
    const proj: ShadertoyProject = {
      passes: [
        pass('bufferA', [{ type: 'buffer', pass: 'bufferB' }]),
        pass('bufferB', [{ type: 'buffer', pass: 'bufferA' }]),
        pass('image', [{ type: 'buffer', pass: 'bufferA' }]),
      ],
    };
    const order = topoOrderPasses(proj);
    expect(new Set(order)).toEqual(new Set(['bufferA', 'bufferB', 'image']));
    expect(order[order.length - 1]).toBe('image');
  });
});

describe('resolveChannels', () => {
  it('pads to 4 slots with {type:none}', () => {
    const ch = resolveChannels(pass('x', [{ type: 'self' }]));
    expect(ch).toHaveLength(4);
    expect(ch[0]).toEqual({ type: 'self' });
    expect(ch[1]).toEqual({ type: 'none' });
    expect(ch[3]).toEqual({ type: 'none' });
  });
});

describe('isShadertoyProject', () => {
  it('accepts a valid project', () => {
    expect(isShadertoyProject({ passes: [{ id: 'image', src: 'x', channels: [] }] })).toBe(true);
  });
  it('rejects malformed shapes', () => {
    expect(isShadertoyProject(null)).toBe(false);
    expect(isShadertoyProject({})).toBe(false);
    expect(isShadertoyProject({ passes: [] })).toBe(false);
    expect(isShadertoyProject({ passes: [{ id: 'x' }] })).toBe(false);
  });
});
