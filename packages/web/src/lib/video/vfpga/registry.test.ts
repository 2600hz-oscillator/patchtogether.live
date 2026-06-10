// packages/web/src/lib/video/vfpga/registry.test.ts
//
// VFPGA catalog validation — runs over EVERY bundled spec (glob-collected), so
// any new specs/<id>.ts auto-enrols. Asserts the invariants the host relies on:
// unique ids, slots within the host superset, videoIn/videoOut within range,
// every declared pass uniform/sampler is reachable, and the docs fields exist.
// (GLSL compilation is asserted in the browser e2e — no GL context in jsdom.)

import { describe, expect, it } from 'vitest';
import { listVfpgaSpecs, getVfpgaSpec, DEFAULT_VFPGA_ID, collectVfpgaSpecs } from './registry';
import {
  VFPGA_CV_PORTS,
  VFPGA_GATE_PORTS,
  VFPGA_PARAM_SLOTS,
  VFPGA_VIDEO_IN_PORTS,
} from './types';

const SPECS = listVfpgaSpecs();

describe('VFPGA registry', () => {
  it('collects at least the smpte-bars spec', () => {
    expect(SPECS.length).toBeGreaterThanOrEqual(1);
    expect(getVfpgaSpec('smpte-bars')).toBeDefined();
  });

  it('the default VFPGA resolves', () => {
    expect(getVfpgaSpec(DEFAULT_VFPGA_ID)).toBeDefined();
  });

  it('ids are unique', () => {
    const ids = SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('docSlugs are unique', () => {
    const slugs = SPECS.map((s) => s.docSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('collectVfpgaSpecs is sorted by id (deterministic menu/docs order)', () => {
    const ids = collectVfpgaSpecs().map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe.each(SPECS.map((s) => [s.id, s] as const))('VFPGA spec: %s', (_id, spec) => {
  it('has the required docs fields (generic, no trademarked names)', () => {
    expect(spec.id).toMatch(/^[a-z0-9-]+$/); // generic kebab id
    expect(spec.name.length).toBeGreaterThan(0);
    expect(spec.doc.length).toBeGreaterThan(20);
    expect(spec.docSlug.length).toBeGreaterThan(0);
    // No trademarked product names leak into the id/slug.
    const banned = /ultimatte|paintbox|videomancer|memory.?palace|fairlight|ado/i;
    expect(spec.id).not.toMatch(banned);
    expect(spec.docSlug).not.toMatch(banned);
  });

  it('videoIn / videoOut are within the host superset range', () => {
    expect(spec.videoIn).toBeGreaterThanOrEqual(0);
    expect(spec.videoIn).toBeLessThanOrEqual(VFPGA_VIDEO_IN_PORTS.length);
    expect([1, 2]).toContain(spec.videoOut);
  });

  it('CV roles map onto valid host CV slots (1..4) with unique slots + uniforms', () => {
    const slots = (spec.cvRoles ?? []).map((r) => r.slot);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(1), expect(s).toBeLessThanOrEqual(VFPGA_CV_PORTS.length);
    expect(new Set(slots).size).toBe(slots.length); // one role per slot
    const uniforms = (spec.cvRoles ?? []).map((r) => r.uniform);
    expect(new Set(uniforms).size).toBe(uniforms.length);
  });

  it('gate roles map onto valid host gate slots (1..4) with unique slots', () => {
    const slots = (spec.gateRoles ?? []).map((r) => r.slot);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(1), expect(s).toBeLessThanOrEqual(VFPGA_GATE_PORTS.length);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('param slots map onto valid host slots (1..8) with unique slots + sane ranges', () => {
    const slots = (spec.params ?? []).map((p) => p.slot);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(1), expect(s).toBeLessThanOrEqual(VFPGA_PARAM_SLOTS.length);
    expect(new Set(slots).size).toBe(slots.length);
    for (const p of spec.params ?? []) {
      expect(p.max).toBeGreaterThan(p.min);
      expect(p.defaultValue).toBeGreaterThanOrEqual(p.min);
      expect(p.defaultValue).toBeLessThanOrEqual(p.max);
      expect(p.uniform.length).toBeGreaterThan(0);
    }
  });

  it('has at least one pass and a vout1 output that resolves to output or a declared fbo', () => {
    expect(spec.effect.passes.length).toBeGreaterThanOrEqual(1);
    const fboIds = new Set((spec.effect.fbos ?? []).map((f) => f.id));
    const valid = (id: string) => id === 'output' || fboIds.has(id);
    expect(valid(spec.effect.outputs.vout1)).toBe(true);
    if (spec.effect.outputs.vout2) expect(valid(spec.effect.outputs.vout2)).toBe(true);
    // videoOut count must match whether vout2 is declared.
    expect(spec.videoOut).toBe(spec.effect.outputs.vout2 ? 2 : 1);
  });

  it('every pass target + sampler source resolves to a host video-in port or a declared fbo', () => {
    const fboIds = new Set((spec.effect.fbos ?? []).map((f) => f.id));
    const vinIds = new Set(VFPGA_VIDEO_IN_PORTS as readonly string[]);
    for (const pass of spec.effect.passes) {
      expect(pass.target === 'output' || fboIds.has(pass.target)).toBe(true);
      for (const inp of pass.inputs ?? []) {
        const ok = vinIds.has(inp.source) || fboIds.has(inp.source);
        expect(ok, `pass input source "${inp.source}" is a host vin port or a declared fbo`).toBe(true);
        // A vinN sampler is only allowed if its index is within videoIn.
        if (inp.source.startsWith('vin')) {
          const n = parseInt(inp.source.slice(3), 10);
          expect(n).toBeLessThanOrEqual(spec.videoIn);
        }
      }
    }
  });

  it('shader source declares the shared #version 300 es fragment contract', () => {
    for (const pass of spec.effect.passes) {
      expect(pass.frag).toContain('#version 300 es');
      expect(pass.frag).toContain('out vec4 outColor');
      expect(pass.frag).toContain('in vec2 vUv');
      // Every uniform the pass declares must appear in the frag source.
      for (const u of pass.uniforms ?? []) {
        if (u === 'uTime' || u === 'uResolution') continue; // host-provided, optional
        expect(pass.frag, `pass declares uniform ${u} → it appears in the source`).toContain(u);
      }
      for (const inp of pass.inputs ?? []) {
        expect(pass.frag).toContain(inp.uniform);
      }
    }
  });
});
