// packages/web/src/lib/video/vfpga/cells/cells.test.ts
//
// Cell-library tests — runs over EVERY glob-collected cell so a new cells/<op>.ts
// auto-enrols. Asserts the kernel<->metadata contract the P&R + validation gate
// rely on: a (type, op) lookup; the kernel declares the shared frag contract,
// one sampler per input, one float uniform per knob. GL-free (no compile — the
// browser e2e asserts GLSL compiles).

import { describe, expect, it } from 'vitest';
import { getCell, hasCell, listCells } from './index';
import { cellInputUniform } from './types';

const CELLS = listCells();

describe('cell library registry', () => {
  it('collects the P0 CLB cells', () => {
    expect(CELLS.length).toBeGreaterThanOrEqual(3);
    expect(hasCell('clb', 'passthru')).toBe(true);
    expect(hasCell('clb', 'mix')).toBe(true);
    expect(hasCell('clb', 'threshold')).toBe(true);
  });

  it('collects the P2 CLB breadth (arith / logic / colour / routing ops)', () => {
    for (const op of ['add', 'multiply', 'diff', 'invert', 'gain', 'select', 'luma', 'hsvShift']) {
      expect(hasCell('clb', op), `clb:${op} registered`).toBe(true);
    }
  });

  it('collects the P2 DSP cells (conv3x3 / mac / quadDemod)', () => {
    expect(hasCell('dsp', 'conv3x3')).toBe(true);
    expect(hasCell('dsp', 'mac')).toBe(true);
    expect(hasCell('dsp', 'quadDemod')).toBe(true);
  });

  it('collects the P2 LUT16 cell', () => {
    expect(hasCell('lut16', 'lut')).toBe(true);
  });

  it('collects the P4 BRAM line-buffer cell (the scaler-glitch star)', () => {
    // BRAM (line/frame memory) — the FPGA video staple — is realised per design
    // §1.1 as an FBO + a kernel that addresses prior rows: the line-buffer tile
    // holds the full-frame FBO and reads neighbouring scanlines by texel offset
    // (config.rows declares the buffer depth, counted against the bramRows budget).
    expect(hasCell('bram', 'linebuf')).toBe(true);
  });

  it('(type, op) keys are unique', () => {
    const keys = CELLS.map((c) => `${c.type}:${c.op}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('listCells is sorted by type:op (deterministic docs order)', () => {
    const keys = CELLS.map((c) => `${c.type}:${c.op}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe.each(CELLS.map((c) => [`${c.type}:${c.op}`, c] as const))('cell %s', (_k, cell) => {
  const frag = cell.kernel({
    uTexFor: (i) => cellInputUniform(i),
    uniformFor: (k) => cell.knobs.find((kb) => kb.name === k)?.uniform ?? `u_${k}`,
  });

  it('the kernel declares the shared #version 300 es fragment contract', () => {
    expect(frag).toContain('#version 300 es');
    expect(frag).toContain('in vec2 vUv');
    expect(frag).toContain('out vec4 outColor');
  });

  it('declares a sampler2D per logical input', () => {
    for (const input of cell.inputs) {
      expect(frag).toContain(`uniform sampler2D ${cellInputUniform(input)}`);
    }
  });

  it('declares a float uniform per knob + sane knob metadata', () => {
    for (const knob of cell.knobs) {
      expect(knob.uniform.length).toBeGreaterThan(0);
      expect(Number.isFinite(knob.defaultValue)).toBe(true);
      expect(frag).toContain(`uniform float ${knob.uniform}`);
    }
  });

  it('getCell round-trips by (type, op)', () => {
    expect(getCell(cell.type, cell.op)).toBe(cell);
  });
});
