// packages/web/src/lib/video/toybox-manifest-integrity.test.ts
//
// DATA-DRIVEN integrity check of the REAL static TOYBOX manifest
// (packages/web/static/toybox/manifest.json) — the single source of truth the
// card faders, the factory's GLSL/OBJ fetch, and the preset loader all read.
//
// This guards the additive content-bank against the failure modes that only
// surface at runtime (a 404 on a misspelled glsl URL, a param whose uniform
// doesn't exist, a builtin id the primitives switch can't dispatch, a bad
// curve enum, a non-finite slider range). It reads the manifest + every
// referenced asset OFF DISK so a missing file fails the unit gate, not a flaky
// e2e fetch.
//
// It cross-checks each builtin model id against primitives.ts' BuiltinPrimitive
// union (via makePrimitive, which is exhaustive over that union) so a manifest
// builtin with no generator — or a generator with no manifest entry surfaced
// here — is caught at build time.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { makePrimitive, type BuiltinPrimitive } from './primitives';
import { isShadertoySource } from './toybox-shadertoy';

const STATIC_ROOT = resolve(__dirname, '../../../static');
const MANIFEST_PATH = join(STATIC_ROOT, 'toybox', 'manifest.json');

interface Param {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  curve: string;
}
interface Content {
  id: string;
  label: string;
  family: string;
  glsl: string;
  shadertoy?: boolean;
  input?: string;
  params: Param[];
}
interface Model {
  id: string;
  label: string;
  obj?: string;
  builtin?: string;
  matcap?: number;
  license?: string;
}
interface Manifest {
  version: number;
  shaders: Content[];
  gen: Content[];
  models: Model[];
  presets?: Array<{ id: string }>;
}

const FAMILIES = new Set(['GEN', 'FX', 'FRAG']);
const CURVES = new Set(['linear', 'log', 'exp', 'discrete']);
// Keep in sync with primitives.ts BuiltinPrimitive — makePrimitive is exhaustive
// over this list, so a typo here OR a missing generator both fail below.
const BUILTINS: BuiltinPrimitive[] = [
  'cube', 'sphere', 'torus', 'hypercube',
  'tetrahedron', 'octahedron', 'icosahedron',
  'cylinder', 'cone', 'torus-knot',
];

/** Resolve a public asset URL (e.g. "/toybox/shaders/x.glsl") to its on-disk
 *  path under packages/web/static. */
function assetPath(publicUrl: string): string {
  return join(STATIC_ROOT, publicUrl.replace(/^\//, ''));
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
const allContent: Content[] = [...manifest.gen, ...manifest.shaders];

describe('TOYBOX manifest integrity (real static manifest)', () => {
  it('parses + has the expected top-level arrays', () => {
    expect(Array.isArray(manifest.gen)).toBe(true);
    expect(Array.isArray(manifest.shaders)).toBe(true);
    expect(Array.isArray(manifest.models)).toBe(true);
    expect(manifest.gen.length).toBeGreaterThan(0);
    expect(manifest.shaders.length).toBeGreaterThan(0);
    expect(manifest.models.length).toBeGreaterThan(0);
  });

  it('every content + model id is unique across the whole manifest', () => {
    const ids = [...allContent.map((c) => c.id), ...manifest.models.map((m) => m.id)];
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) dups.push(id);
      seen.add(id);
    }
    expect(dups).toEqual([]);
  });

  it('positional defaults are preserved (first GEN entry id stays present; first model is "spot")', () => {
    // The factory's DEFAULT_CONTENT_ID/DEFAULT_MODEL_ID are positional-sensitive
    // in spirit — guard that the canonical default model leads the list and the
    // default content id is still a real GEN entry.
    expect(manifest.models[0]!.id).toBe('spot');
    expect(manifest.gen.some((g) => g.id === 'noise-fbm')).toBe(true);
  });

  it('every content entry has a family in the union + a glsl url whose file exists', () => {
    for (const c of allContent) {
      expect(FAMILIES.has(c.family), `${c.id}: family ${c.family}`).toBe(true);
      expect(typeof c.glsl, `${c.id}: glsl url`).toBe('string');
      expect(existsSync(assetPath(c.glsl)), `${c.id}: missing ${c.glsl}`).toBe(true);
    }
  });

  it('every declared param has finite min<=default<=max + a valid curve', () => {
    for (const c of allContent) {
      expect(Array.isArray(c.params), `${c.id}: params`).toBe(true);
      for (const p of c.params) {
        expect(typeof p.id, `${c.id}.${p.id}`).toBe('string');
        for (const k of ['min', 'max', 'default'] as const) {
          expect(Number.isFinite(p[k]), `${c.id}.${p.id}.${k} finite`).toBe(true);
        }
        expect(p.min, `${c.id}.${p.id}: min<=default`).toBeLessThanOrEqual(p.default);
        expect(p.default, `${c.id}.${p.id}: default<=max`).toBeLessThanOrEqual(p.max);
        expect(CURVES.has(p.curve), `${c.id}.${p.id}: curve ${p.curve}`).toBe(true);
      }
      // No duplicate param ids within an entry.
      const pids = c.params.map((p) => p.id);
      expect(new Set(pids).size, `${c.id}: duplicate param ids`).toBe(pids.length);
    }
  });

  it('each FX/FRAG shader entry declares at least one param (a card fader)', () => {
    // GEN may be fully parameter-free (e.g. a fixed Shadertoy port like
    // synthwave-sunset). FX/FRAG effects always expose at least one control.
    for (const c of manifest.shaders) {
      expect(c.params.length, `${c.id}: expected >=1 param`).toBeGreaterThanOrEqual(1);
    }
  });

  it("each declared param maps to a `uniform float <id>` in its shader source", () => {
    for (const c of allContent) {
      const src = readFileSync(assetPath(c.glsl), 'utf8');
      for (const p of c.params) {
        // Shadertoy shaders get their param uniforms injected by the shim, so
        // the source REFERENCES the name but doesn't declare it; non-shadertoy
        // engine shaders declare `uniform float <id>;` directly. Either way the
        // name must appear as a whole-word token in the source.
        const re = new RegExp(`\\b${p.id}\\b`);
        expect(re.test(src), `${c.id}: param '${p.id}' not used in ${c.glsl}`).toBe(true);
      }
    }
  });

  it('FRAG-family shaders take scene input + use the Shadertoy mainImage convention reading iChannel0', () => {
    for (const c of allContent.filter((x) => x.family === 'FRAG')) {
      expect(c.input, `${c.id}: FRAG must input 'scene'`).toBe('scene');
      expect(c.shadertoy, `${c.id}: FRAG must flag shadertoy`).toBe(true);
      const src = readFileSync(assetPath(c.glsl), 'utf8');
      expect(isShadertoySource(src), `${c.id}: FRAG must define mainImage`).toBe(true);
      expect(/\biChannel0\b/.test(src), `${c.id}: FRAG must read iChannel0`).toBe(true);
    }
  });

  it('GEN/FX (non-shadertoy) engine shaders use #version 300 es + out vec4', () => {
    for (const c of allContent) {
      if (c.shadertoy) continue; // shim supplies the header for these
      const src = readFileSync(assetPath(c.glsl), 'utf8');
      expect(/#version 300 es/.test(src), `${c.id}: needs #version 300 es`).toBe(true);
      expect(/\bout\s+vec4\b/.test(src), `${c.id}: needs out vec4`).toBe(true);
      expect(/\bvoid\s+main\s*\(/.test(src), `${c.id}: needs main()`).toBe(true);
    }
  });

  it('every model is either a builtin (in the BuiltinPrimitive union) or an OBJ whose file exists', () => {
    for (const m of manifest.models) {
      const isBuiltin = typeof m.builtin === 'string';
      const isObj = typeof m.obj === 'string';
      expect(isBuiltin || isObj, `${m.id}: needs builtin or obj`).toBe(true);
      expect(isBuiltin && isObj, `${m.id}: can't be both`).toBe(false);
      if (isBuiltin) {
        expect(BUILTINS.includes(m.builtin as BuiltinPrimitive), `${m.id}: unknown builtin '${m.builtin}'`).toBe(true);
        // The generator must actually dispatch (exhaustive switch over the union).
        const mesh = makePrimitive(m.builtin as BuiltinPrimitive);
        expect(mesh.vertexCount).toBeGreaterThan(0);
        expect(mesh.triangleCount).toBeGreaterThan(0);
      } else {
        expect(existsSync(assetPath(m.obj!)), `${m.id}: missing ${m.obj}`).toBe(true);
      }
    }
  });

  it('every builtin in the BuiltinPrimitive union has a manifest model entry', () => {
    const manifestBuiltins = new Set(
      manifest.models.filter((m) => m.builtin).map((m) => m.builtin),
    );
    for (const b of BUILTINS) {
      expect(manifestBuiltins.has(b), `builtin '${b}' has no manifest model`).toBe(true);
    }
  });

  it('every OBJ model declares a license tag (CC0/MIT provenance)', () => {
    for (const m of manifest.models.filter((x) => x.obj)) {
      expect(typeof m.license, `${m.id}: license tag`).toBe('string');
      expect(m.license!.length, `${m.id}: non-empty license`).toBeGreaterThan(0);
    }
  });
});
