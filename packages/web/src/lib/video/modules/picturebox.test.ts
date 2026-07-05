// packages/web/src/lib/video/modules/picturebox.test.ts
//
// Def-shape + factory (7-slot asset switching, animated-gif playback) tests
// for PICTUREBOX. The old v1→v4 old-patch migrate() was dropped in the schema
// cleanup (cleanup 2/5); a fresh save stamps the current version so no migrate
// ever fires for new patches.

import { describe, expect, it, vi } from 'vitest';
import { pictureboxDef, type PictureboxHandleExtras } from './picturebox';
import type { DecodedGifFrame } from './gif-frames';
import type { VideoEngineContext } from '$lib/video/engine';
import type { ModuleNode } from '$lib/graph/types';
import { ASSET_SLOTS, ASSET_SLOT_NOTES, slotForVOct } from '$lib/video/asset-select';
import { midiToVOct } from '$lib/audio/note-entry';

describe('PICTUREBOX def', () => {
  it('declares maxInstances = 8 (workspace cap mirror)', () => {
    expect(pictureboxDef.maxInstances).toBe(8);
  });
});

describe('PICTUREBOX def — port surface (v3 asset-selector ports added)', () => {
  it('keeps gain in + image out, and adds asset_pitch + asset_gate inputs', () => {
    expect(pictureboxDef.inputs.map((p) => p.id)).toEqual(['gain', 'asset_pitch', 'asset_gate']);
    expect(pictureboxDef.inputs[0]?.type).toBe('cv');
    expect(pictureboxDef.outputs.map((p) => p.id)).toEqual(['out']);
    expect(pictureboxDef.outputs[0]?.type).toBe('image');
  });

  it('asset_pitch is a pitch input with NO cvScale hint (raw V/oct passthrough)', () => {
    const ap = pictureboxDef.inputs.find((p) => p.id === 'asset_pitch')!;
    expect(ap.type).toBe('pitch');
    expect(ap.paramTarget).toBe('asset_pitch');
    expect(ap.cvScale).toBeUndefined();
  });

  it('asset_gate is a gate input routed to a synthetic param', () => {
    const ag = pictureboxDef.inputs.find((p) => p.id === 'asset_gate')!;
    expect(ag.type).toBe('gate');
    expect(ag.paramTarget).toBe('asset_gate');
  });

  it('every cv/gate/pitch input has a paramTarget that exists in params', () => {
    const paramIds = new Set(pictureboxDef.params.map((p) => p.id));
    for (const port of pictureboxDef.inputs) {
      if (port.type === 'cv' || port.type === 'gate' || port.type === 'pitch') {
        expect(port.paramTarget, `${port.id} has paramTarget`).toBeDefined();
        expect(paramIds.has(port.paramTarget!), `${port.id} → ${port.paramTarget}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Factory: 7-slot asset switching (fake GL — no WebGL). Mirrors the fake-GL
// pattern in scoreboard.test.ts / 4plexvid.test.ts.
// ---------------------------------------------------------------------------

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub,
    createTexture: () => ({}),
    bindTexture: () => undefined,
    texParameteri: () => undefined,
    texImage2D: () => undefined,
    pixelStorei: () => undefined,
    deleteTexture: () => undefined,
    deleteFramebuffer: () => undefined,
    deleteProgram: () => undefined,
    activeTexture: () => undefined,
    bindFramebuffer: () => undefined,
    viewport: () => undefined,
    useProgram: () => undefined,
    uniform1i: () => undefined,
    uniform1f: () => undefined,
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0,
    TEXTURE_MIN_FILTER: 0, TEXTURE_MAG_FILTER: 0,
    TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0,
    LINEAR: 0, CLAMP_TO_EDGE: 0,
    UNPACK_FLIP_Y_WEBGL: 0,
    TEXTURE0: 0,
    FRAMEBUFFER: 0,
  } as unknown as WebGL2RenderingContext;
}

function makeCtx(): VideoEngineContext {
  return {
    gl: makeFakeGl(),
    res: { width: 1024, height: 768 },
    compileFragment: () => ({}) as WebGLProgram,
    createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
    drawFullscreenQuad: () => undefined,
  };
}

function spawn(params: Record<string, number> = {}) {
  const node = {
    id: 'pb',
    type: 'picturebox',
    domain: 'video',
    params,
    position: { x: 0, y: 0 },
  } as ModuleNode;
  return pictureboxDef.factory(makeCtx(), node);
}

function extrasOf(h: ReturnType<typeof spawn>): PictureboxHandleExtras {
  return h.read?.('extras') as PictureboxHandleExtras;
}

/** A non-null stand-in bitmap for upload (the fake GL ignores it). */
const FAKE_BITMAP = {} as ImageBitmap;

describe('pictureboxDef.factory — 7-slot asset selection', () => {
  it('starts at slot 0 with no image', () => {
    const h = spawn();
    expect(h.read?.('activeSlot')).toBe(0);
    expect(h.read?.('hasImage')).toBe(false);
  });

  it('setAssetAtSlot + selectSlot switches the active slot', () => {
    const h = spawn();
    const ex = extrasOf(h);
    ex.setAssetAtSlot(2, FAKE_BITMAP);
    expect(ex.slotHasAsset(2)).toBe(true);
    expect(ex.slotHasAsset(0)).toBe(false);
    expect(ex.selectSlot(2)).toBe(true);
    expect(ex.activeSlot()).toBe(2);
    expect(h.read?.('hasImage')).toBe(true);
  });

  it('selectSlot is a no-op on an EMPTY slot (keeps current)', () => {
    const h = spawn();
    const ex = extrasOf(h);
    ex.setAssetAtSlot(0, FAKE_BITMAP);
    ex.selectSlot(0);
    expect(ex.selectSlot(4)).toBe(false); // slot 4 empty
    expect(ex.activeSlot()).toBe(0); // unchanged
  });

  it('selectSlot rejects out-of-range indices', () => {
    const h = spawn();
    const ex = extrasOf(h);
    ex.setAssetAtSlot(0, FAKE_BITMAP);
    expect(ex.selectSlot(-1)).toBe(false);
    expect(ex.selectSlot(ASSET_SLOTS)).toBe(false);
    expect(ex.activeSlot()).toBe(0);
  });

  it('an asset_gate rising edge + a white-key asset_pitch selects the right slot', () => {
    // Simulate the card's gate loop: write the bridge params, then run the
    // same decision the card runs (rising edge → slotForVOct → selectSlot).
    const h = spawn();
    const ex = extrasOf(h);
    // Load every slot so the switch isn't suppressed by an empty slot.
    for (let i = 0; i < ASSET_SLOTS; i++) ex.setAssetAtSlot(i, FAKE_BITMAP);

    function fireGate(pitchVOct: number): void {
      h.setParam('asset_pitch', pitchVOct);
      h.setParam('asset_gate', 1); // rising edge
      const slot = slotForVOct(h.readParam?.('asset_pitch') ?? 0);
      if (slot != null && ex.slotHasAsset(slot)) ex.selectSlot(slot);
      h.setParam('asset_gate', 0); // release
    }

    // E3 (MIDI 52) → slot 2.
    fireGate(midiToVOct(ASSET_SLOT_NOTES[2]!));
    expect(ex.activeSlot()).toBe(2);
    // A4 (MIDI 69, pitch class A) → slot 5 (octave-independent).
    fireGate(midiToVOct(69));
    expect(ex.activeSlot()).toBe(5);
  });

  it('a black-key asset_pitch on the gate edge is IGNORED (keep current)', () => {
    const h = spawn();
    const ex = extrasOf(h);
    for (let i = 0; i < ASSET_SLOTS; i++) ex.setAssetAtSlot(i, FAKE_BITMAP);
    ex.selectSlot(3);
    expect(ex.activeSlot()).toBe(3);
    // C#4 (MIDI 61) is a black key → slotForVOct returns null → ignore.
    const slot = slotForVOct(midiToVOct(61));
    expect(slot).toBeNull();
    if (slot != null && ex.slotHasAsset(slot)) ex.selectSlot(slot);
    expect(ex.activeSlot()).toBe(3); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Animated GIF: frame scheduling on the engine clock + no-leak teardown.
// draw() only uses frame.gl + frame.time (the rest of the fake ctx is stubbed).
// ---------------------------------------------------------------------------

/** A fake ImageBitmap with a spy-able close() so leak tests can assert release. */
function animBitmap(): ImageBitmap {
  return { close: vi.fn() } as unknown as ImageBitmap;
}
function frames(durationsMs: number[]): DecodedGifFrame[] {
  return durationsMs.map((durationMs) => ({ bitmap: animBitmap(), durationMs }));
}
/** Drive one engine draw at a given ctx.time (seconds). */
function drawAt(h: ReturnType<typeof spawn>, timeSec: number): void {
  const frame = { gl: makeFakeGl(), time: timeSec } as unknown as Parameters<typeof h.surface.draw>[0];
  h.surface.draw(frame);
}

describe('pictureboxDef.factory — animated gif playback', () => {
  it('installs frames, shows frame 0, and steps by ctx.time (looping)', () => {
    const h = spawn();
    const ex = extrasOf(h);
    ex.setAnimatedImage(frames([100, 100, 100])); // total 300ms
    expect(h.read?.('hasImage')).toBe(true);
    expect(h.read?.('activeAnimFrame')).toBe(0);

    drawAt(h, 0); // seeds startTime=0 → frame 0
    expect(h.read?.('activeAnimFrame')).toBe(0);
    drawAt(h, 0.15); // 150ms → frame 1
    expect(h.read?.('activeAnimFrame')).toBe(1);
    drawAt(h, 0.25); // 250ms → frame 2
    expect(h.read?.('activeAnimFrame')).toBe(2);
    drawAt(h, 0.35); // 350ms → 50ms into the loop → frame 0
    expect(h.read?.('activeAnimFrame')).toBe(0);
  });

  it('a static image replacing a gif clears the animation', () => {
    const h = spawn();
    const ex = extrasOf(h);
    ex.setAnimatedImage(frames([100, 100]));
    expect(h.read?.('activeAnimFrame')).toBe(0);
    ex.setImage(FAKE_BITMAP); // static replaces the animation
    expect(h.read?.('activeAnimFrame')).toBe(-1);
    expect(h.read?.('hasImage')).toBe(true); // still shows the static image
  });

  it('selectSlot restarts the newly-active gif from frame 0', () => {
    const h = spawn();
    const ex = extrasOf(h);
    ex.setAnimatedAtSlot(0, frames([100, 100, 100]));
    ex.setAnimatedAtSlot(1, frames([100, 100, 100]));
    // Advance slot 0 to a later frame.
    drawAt(h, 0);
    drawAt(h, 0.25);
    expect(h.read?.('activeAnimFrame')).toBe(2);
    // Switch to slot 1: it starts fresh at frame 0.
    expect(ex.selectSlot(1)).toBe(true);
    expect(h.read?.('activeAnimFrame')).toBe(0);
    drawAt(h, 5.0); // seeds slot-1 startTime=5.0 → still frame 0 at t=5.0
    expect(h.read?.('activeAnimFrame')).toBe(0);
  });

  it('closes every frame bitmap on replace, clear, and dispose (no leak)', () => {
    const h = spawn();
    const ex = extrasOf(h);
    const a = frames([100, 100]);
    ex.setAnimatedImage(a);
    // Replacing with a new animation closes the old frames.
    ex.setAnimatedImage(frames([100]));
    for (const f of a) expect((f.bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();

    // Clearing closes the current frames.
    const b = frames([100, 100, 100]);
    ex.setAnimatedAtSlot(2, b);
    ex.setAnimatedAtSlot(2, null);
    for (const f of b) expect((f.bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();

    // Dispose closes whatever remains resident across all slots.
    const c = frames([100, 100]);
    ex.setAnimatedAtSlot(3, c);
    h.dispose();
    for (const f of c) expect((f.bitmap as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  });
});
