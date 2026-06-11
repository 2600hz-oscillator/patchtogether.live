// packages/web/src/lib/video/vfpga/cells/types.ts
//
// The CELL LIBRARY — the fabric's "primitive cells" (design §1.3). Each fabric
// tile `type`+`op` maps to ONE cell: a GLSL kernel TEMPLATE the place-and-route
// step instantiates with the tile's config, plus the metadata P&R + validation
// need (which inputs the kernel samples, which config knobs/uniforms it reads).
//
// Cells live in `cells/*.ts` and are GLOB-collected (`import.meta.glob`, same
// pattern as the specs registry) so adding a tile op is a drop-in file with ZERO
// shared-index edit (no merge-conflict surface across concurrent cell PRs).
//
// v1 SCOPE (P0): only the 3 trivial CLB cells (`passthru`, `mix`, `threshold`).
// DSP/BRAM/reg/LUT16 kernels are later phases; their tile TYPES exist in the
// type union now but have no cell yet (validation reports a referenced op with
// no cell as an error). IOB in/out adapters are NOT cells — they are fixed
// fabric-edge tiles P&R handles directly (no kernel of their own).

import type { VfpgaTileType } from '$lib/video/vfpga/types';

/** One configurable knob a cell's kernel reads as a `float` uniform. The fabric
 *  tile's `config.consts[knob]` (static) OR `config.bind[].knob===knob` (a
 *  p/cv/gate binding) supplies its value; if neither, P&R uses `defaultValue`. */
export interface VfpgaCellKnob {
  /** Knob name (matches a `config.consts` key / a `config.bind[].knob`). */
  name: string;
  /** The GLSL `float` uniform the kernel reads this knob from. */
  uniform: string;
  /** Value used when the tile neither sets a const nor binds the knob. */
  defaultValue: number;
  /** Optional human label for the docs/floorplan. */
  label?: string;
  doc?: string;
}

/** A primitive cell — a parameterised kernel one fabric tile type can run. */
export interface VfpgaCell {
  /** The tile `type` this cell belongs to (P0: only 'clb'). */
  type: VfpgaTileType;
  /** The `op` name selecting this cell within its type (`config.op`). Unique
   *  per (type, op). */
  op: string;
  /** Logical input names the kernel samples, in binding order. A net targets
   *  `<tileId>:<inputName>`; P&R binds each to a sampler uniform `uTex_<name>`.
   *  An empty list = a generator/0-input cell. */
  inputs: string[];
  /** The config knobs the kernel reads (each a `float` uniform). */
  knobs: VfpgaCellKnob[];
  /** Build the GLSL #version 300 es fragment for this cell. The returned source
   *  MUST declare the shared `in vec2 vUv; out vec4 outColor;` contract, a
   *  `uniform sampler2D uTex_<name>;` per input (use `uTexFor(name)`), and a
   *  `uniform float <uniform>;` per knob (use `uniformFor(knob)`, which returns
   *  the knob's declared `uniform` name). Routing the uniform names through
   *  these helpers keeps the kernel<->metadata contract single-sourced. */
  kernel(opts: {
    /** The sampler uniform for a logical input (`a` → `uTex_a`). */
    uTexFor: (input: string) => string;
    /** The float uniform for a config knob (its `VfpgaCellKnob.uniform`). */
    uniformFor: (knob: string) => string;
  }): string;
  /** One-line description for the docs/floorplan. */
  doc?: string;
}

/** The sampler uniform name P&R binds a cell input to (`a` → `uTex_a`). Shared
 *  by the cell kernels + P&R so the contract is single-sourced. */
export const cellInputUniform = (input: string): string => `uTex_${input}`;
