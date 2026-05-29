// packages/web/src/lib/ui/example-patches/glitches.test.ts
//
// Unit coverage for the GLITCHES GET RICHES demo fixture + its loader.
//
// What this test guards:
//   1. The shipped JSON envelope still matches the documented
//      PatchEnvelope shape (envelopeVersion 1, savedAt, moduleSchemas,
//      update). If anyone replaces glitches.imp.json with a malformed
//      blob this fails CI before the e2e even runs.
//   2. The envelope's moduleSchemas advertises the modules the GLITCHES
//      patch actually uses (picturebox + lfo + score-adjacent voices).
//      This is the regression net for "someone re-exported the patch
//      from a build that dropped a module."
//   3. `loadGlitches` returns a LoadResult against a fresh fake store
//      and the resulting store contains a picturebox node with the
//      bundled image bytes attached.
//
// The audio engine is NOT exercised here — that half of the load path is
// covered by the @load-tagged Playwright spec (glitches-button.spec.ts).

import { describe, it, expect, beforeAll } from 'vitest';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { registerModule, type AudioModuleDef } from '$lib/audio/module-registry';
import { registerVideoModule, type VideoModuleDef } from '$lib/video/module-registry';
import { parseEnvelope, ENVELOPE_VERSION, type LivePatch } from '$lib/graph/persistence';
import type { ModuleNode, Edge } from '$lib/graph/types';
import { GLITCHES_ENVELOPE_RAW, getGlitchesEnvelope, loadGlitches } from './glitches';

// ---------------- Test fixtures ----------------

const throwingFactory = (): never => {
  throw new Error('factory should not be called from glitches.test.ts');
};

/** Minimal picturebox def — just enough for loadEnvelopeIntoStore to
 *  accept the envelope's picturebox node (it reads schemaVersion +
 *  optional migrate, never calls factory). The real def lives in
 *  $lib/video/modules/picturebox.ts; we stub here to avoid pulling in
 *  the WebGL2 surface (which doesn't resolve outside SvelteKit). */
const stubPictureboxDef: VideoModuleDef = {
  type: 'picturebox',
  domain: 'video',
  label: 'PICTUREBOX',
  category: 'sources',
  schemaVersion: 2,
  inputs: [{ id: 'gain', type: 'cv', paramTarget: 'gain' }],
  outputs: [{ id: 'out', type: 'image' }],
  params: [{ id: 'gain', label: 'Gain', defaultValue: 1, min: 0, max: 2, curve: 'linear' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: throwingFactory as any,
};

/** Minimal audio def stub for any module type we need to keep
 *  loadEnvelopeIntoStore from filing a "module type not registered"
 *  diagnostic. We only register picturebox since the spec calls it out;
 *  every other type in the envelope is allowed to be dropped (the
 *  loader is lenient + records them as diagnostics, doesn't throw). */
function makeStubAudio(type: string): AudioModuleDef {
  return {
    type,
    domain: 'audio',
    label: type.toUpperCase(),
    category: 'sources',
    schemaVersion: 1,
    inputs: [],
    outputs: [],
    params: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: throwingFactory as any,
  };
}

function freshPatch() {
  const store = syncedStore<{ nodes: Record<string, ModuleNode>; edges: Record<string, Edge> }>({
    nodes: {},
    edges: {},
  });
  const ydoc = getYjsDoc(store);
  return { store: store as unknown as LivePatch, ydoc };
}

// ---------------- Setup ----------------

beforeAll(() => {
  // Only picturebox is required by the test assertions below; we don't
  // pull in $lib/audio/modules (the barrel imports WASM `?url` loaders
  // that need Vite). Other module types in the envelope just become
  // diagnostics; the loader still completes successfully.
  registerVideoModule(stubPictureboxDef);
  // Register a few common audio types so the LoadResult's nodesLoaded
  // count is non-trivial (cosmetic — the load-result test only asserts
  // it's > 0).
  for (const t of ['lfo', 'mixer', 'audioOut', 'timelorde', 'drumseqz']) {
    registerModule(makeStubAudio(t));
  }
});

// ---------------- Tests ----------------

describe('glitches: envelope shape', () => {
  it('imports as a non-null JSON object', () => {
    expect(GLITCHES_ENVELOPE_RAW).toBeTypeOf('object');
    expect(GLITCHES_ENVELOPE_RAW).not.toBeNull();
  });

  it('parses into a PatchEnvelope (version 1, moduleSchemas + update present)', () => {
    const env = getGlitchesEnvelope();
    expect(env.envelopeVersion).toBe(ENVELOPE_VERSION);
    expect(typeof env.savedAt).toBe('string');
    expect(new Date(env.savedAt).getTime()).toBeGreaterThan(0);
    expect(env.moduleSchemas).toBeTypeOf('object');
    expect(typeof env.update).toBe('string');
    expect(env.update.length).toBeGreaterThan(0);
    // Base64 alphabet.
    expect(env.update).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('moduleSchemas advertises picturebox + lfo + score-adjacent modules', () => {
    const env = getGlitchesEnvelope();
    // Spec asked for picturebox, doom, gamepad, lfo, score. The actual
    // envelope captured by the user contains picturebox + lfo + score-
    // adjacent voices (drumseqz, macseq, etc.) but NOT doom/gamepad —
    // the patch is video-glitch flavoured rather than game-flavoured.
    // Assert the subset that actually ships so this test stays honest
    // about the fixture content. Update this list if the fixture is
    // re-exported with a different module mix.
    expect(env.moduleSchemas).toHaveProperty('picturebox');
    expect(env.moduleSchemas).toHaveProperty('lfo');
    expect(env.moduleSchemas).toHaveProperty('score');
    // Sanity: the envelope is for a real rackspace with many modules.
    expect(Object.keys(env.moduleSchemas).length).toBeGreaterThan(10);
  });

  it('re-validates through parseEnvelope cleanly (idempotent shape check)', () => {
    const env = getGlitchesEnvelope();
    const reparsed = parseEnvelope(JSON.stringify(env));
    expect(reparsed.envelopeVersion).toBe(env.envelopeVersion);
    expect(reparsed.savedAt).toBe(env.savedAt);
    expect(reparsed.update).toBe(env.update);
  });
});

describe('glitches: loadGlitches against a fake store', () => {
  it('loads at least one node + ships a non-empty PICTUREBOX with imageBytes', () => {
    const { store, ydoc } = freshPatch();
    const result = loadGlitches(ydoc, store);

    // Some nodes must land. Even though most module types are stubbed
    // away (and many drop to diagnostics) the registered picturebox + the
    // five audio stubs above should all stick.
    expect(result.nodesLoaded).toBeGreaterThan(0);

    // The PICTUREBOX node should be in the live store with imageBytes
    // populated — that's how PictureboxCard auto-renders glitch.jpg on
    // mount in the running app (no URL fetch needed; the envelope
    // already carries the bytes).
    const pictureboxNodes = Object.values(store.nodes).filter((n): n is ModuleNode => n?.type === 'picturebox');
    expect(pictureboxNodes.length).toBeGreaterThan(0);
    const pb = pictureboxNodes[0]!;
    const data = pb.data as { imageBytes?: string | null; imageMime?: string; imageName?: string } | undefined;
    expect(data).toBeDefined();
    expect(typeof data?.imageBytes).toBe('string');
    expect((data?.imageBytes ?? '').length).toBeGreaterThan(1000);
    expect(data?.imageMime).toBe('image/jpeg');
  });

  it('is idempotent — calling twice yields a store with the same picturebox node', () => {
    const { store, ydoc } = freshPatch();
    loadGlitches(ydoc, store);
    const firstPictureboxIds = Object.values(store.nodes)
      .filter((n): n is ModuleNode => n?.type === 'picturebox')
      .map((n) => n.id)
      .sort();

    loadGlitches(ydoc, store);
    const secondPictureboxIds = Object.values(store.nodes)
      .filter((n): n is ModuleNode => n?.type === 'picturebox')
      .map((n) => n.id)
      .sort();

    // loadEnvelopeIntoStore clears + re-adds atomically, so reload yields
    // the same node ids (deterministic from the envelope), never
    // duplicates.
    expect(secondPictureboxIds).toEqual(firstPictureboxIds);
  });
});
