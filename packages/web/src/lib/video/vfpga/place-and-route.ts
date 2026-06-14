// packages/web/src/lib/video/vfpga/place-and-route.ts
//
// PLACE & ROUTE — the pure, GL-FREE compile step (design §1.2) that lowers a
// fabric configuration ("the bitstream") into the foundation's `VfpgaEffect`
// shape the factory's `buildEffect` already consumes. NO WebGL here: this is
// plain data → data (topo-sort, comb-loop reject, FBO assignment, pass
// emission), unit-tested in jsdom exactly like the b3ntb0x DSP math.
//
//   .vfpga fabric (tiles[] + nets[] + outputs + budget)
//        │  1. validate + resolve every net endpoint
//        │  2. build the tile dependency graph (a net A→B means B reads A);
//        │     a `<reg>:prev` read = PREVIOUS frame → does NOT create a
//        │     this-frame dependency (it cuts the feedback edge → DAG)
//        │  3. topological sort the DAG (combinational pass order); a remaining
//        │     cycle = a combinational loop → REJECT (authentic: an FPGA can't
//        │     have a comb cycle either — feedback must pass a register)
//        │  4. assign each tile an FBO (rgba8 default; float when kind==='float';
//        │     a register gets a ping-pong PAIR; the OUTPUT target maps to the
//        │     surface 'output')
//        │  5. emit an ordered PASS LIST: per tile the instantiated cell kernel,
//        │     its resolved input-sampler bindings, and its uniform set
//        ▼
//   VfpgaEffect { passes[], fbos[], outputs } — fed UNCHANGED to buildEffect.
//
// P&R assigns each register tile a ping-pong FBO pair (front/back), routes
// `:prev` reads to the back buffer, and (P1) emits a `registers[]` list of those
// pairs on the effect so the HOST swaps front↔back at end of frame (the clock
// edge — see vfpga-runner.ts draw()). The cells that exist are the 3 CLB cells
// (+ the smpte generator) + IOB in/out adapters; DSP/BRAM/LUT16 are later phases.

import {
  VFPGA_IOB_IN_PORTS,
  VFPGA_IOB_OUT,
  iobIinToVin,
  type VfpgaEffect,
  type VfpgaFabric,
  type VfpgaFbo,
  type VfpgaPass,
  type VfpgaRegisterPair,
  type VfpgaTile,
} from './types';
import { getCell } from './cells';
import { cellInputUniform, type VfpgaCell } from './cells/types';

/** A diagnostic the validation gate surfaces. `path` localises the offender. */
export interface FabricError {
  message: string;
  path?: string;
}

/** The single logical input a register tile captures into its front buffer. */
const REG_INPUT = 'a';

/** A register tile whose op is the IMPLICIT 1-frame capture (no cell kernel of
 *  its own — it just writes its `a`-driving net into the ping-pong front buffer;
 *  reads via `<id>:prev` see the back buffer = last frame). Plain `reg` (or no
 *  op) is the P0 capture; clocked/feedbackMix reg ops (later phases) DO carry a
 *  cell. */
function isImplicitRegCapture(tile: VfpgaTile): boolean {
  return tile.type === 'reg' && (tile.config.op === undefined || tile.config.op === 'reg');
}

/** The implicit register-capture kernel: a passthru that writes its `a` input
 *  into the register's ping-pong front buffer (mirrors the cells' frag contract;
 *  same `uTex_a` sampler name P&R binds). */
const REG_CAPTURE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D ${cellInputUniform(REG_INPUT)};
void main() {
  outColor = texture(${cellInputUniform(REG_INPUT)}, vUv);
}`;

/** Thrown by {@link fabricToEffect} when a fabric is structurally invalid. The
 *  `errors` carry every diagnostic so callers/tests can assert specifics. */
export class FabricCompileError extends Error {
  readonly errors: FabricError[];
  constructor(errors: FabricError[]) {
    super(`vfpga fabric is invalid:\n  ${errors.map((e) => e.message).join('\n  ')}`);
    this.name = 'FabricCompileError';
    this.errors = errors;
  }
}

// ----------------------------------------------------------------------
// Net-endpoint parsing.
// ----------------------------------------------------------------------

/** A resolved `net.from` source. */
type ResolvedSource =
  | { kind: 'iobIn'; port: string } // IIN/CIN/GIN host-edge input
  | { kind: 'tile'; tileId: string } // a tile's this-frame output
  | { kind: 'regPrev'; tileId: string }; // a register's previous-frame back-buffer

/** A resolved `net.to` destination. */
type ResolvedDest =
  | { kind: 'tileInput'; tileId: string; input: string }
  | { kind: 'out'; port: string }; // OUT1/OUT2

function parseFrom(from: string): ResolvedSource {
  if ((VFPGA_IOB_IN_PORTS as readonly string[]).includes(from)) {
    return { kind: 'iobIn', port: from };
  }
  if (from.endsWith(':prev')) {
    return { kind: 'regPrev', tileId: from.slice(0, -':prev'.length) };
  }
  return { kind: 'tile', tileId: from };
}

function parseTo(to: string): ResolvedDest {
  if ((VFPGA_IOB_OUT as readonly string[]).includes(to)) {
    return { kind: 'out', port: to };
  }
  const colon = to.indexOf(':');
  if (colon < 0) {
    // No `:input` → an ill-formed tile destination; flagged in validation.
    return { kind: 'tileInput', tileId: to, input: '' };
  }
  return { kind: 'tileInput', tileId: to.slice(0, colon), input: to.slice(colon + 1) };
}

// ----------------------------------------------------------------------
// Validation (design §2.1) — pure; returns every diagnostic, throws nothing.
// fabricToEffect runs this first and throws a FabricCompileError if non-empty.
// ----------------------------------------------------------------------

/** Validate a fabric end-to-end and return every diagnostic (empty = valid).
 *  Checks: unique tile ids; IOB tiles ⊆ host superset; every net.from/net.to
 *  resolves; no combinational cycle (cycles must pass a `:prev` reg edge);
 *  referenced tile (type, op) exists in the cell library; outputs resolve;
 *  budget (dsp / bramRows / passes) not exceeded. */
export function validateFabric(fabric: VfpgaFabric): FabricError[] {
  const errors: FabricError[] = [];
  const tilesById = new Map<string, VfpgaTile>();

  // --- unique tile ids ---
  for (const t of fabric.tiles) {
    if (tilesById.has(t.id)) {
      errors.push({ message: `duplicate tile id "${t.id}"`, path: `tiles/${t.id}` });
      continue;
    }
    tilesById.set(t.id, t);
  }

  // --- per-tile: IOB superset membership + cell existence + input names ---
  const cellByTile = new Map<string, VfpgaCell>();
  for (const t of fabric.tiles) {
    if (t.type === 'iob_in') {
      const port = t.config.op ?? '';
      if (!(VFPGA_IOB_IN_PORTS as readonly string[]).includes(port)) {
        errors.push({
          message: `iob_in tile "${t.id}" op "${port}" is not a host IOB-in port (IIN/CIN/GIN 1..4)`,
          path: `tiles/${t.id}`,
        });
      }
    } else if (t.type === 'iob_out') {
      const port = t.config.op ?? '';
      if (!(VFPGA_IOB_OUT as readonly string[]).includes(port)) {
        errors.push({
          message: `iob_out tile "${t.id}" op "${port}" is not a host IOB-out port (OUT1/OUT2)`,
          path: `tiles/${t.id}`,
        });
      }
    } else if (isImplicitRegCapture(t)) {
      // An implicit register-capture tile carries no cell — it captures its
      // single `a` input into the ping-pong front buffer (P0). Any declared
      // input other than `a` is invalid.
      for (const inp of t.inputs ?? []) {
        if (inp !== REG_INPUT) {
          errors.push({
            message: `register tile "${t.id}" only captures input "${REG_INPUT}" (got "${inp}")`,
            path: `tiles/${t.id}`,
          });
        }
      }
    } else {
      const op = t.config.op ?? '';
      const cell = getCell(t.type, op);
      if (!cell) {
        errors.push({
          message: `tile "${t.id}" references unknown cell ${t.type}:"${op}" (no kernel in the cell library)`,
          path: `tiles/${t.id}`,
        });
      } else {
        cellByTile.set(t.id, cell);
        // Each declared input name must be one the cell actually samples.
        for (const inp of t.inputs ?? []) {
          if (!cell.inputs.includes(inp)) {
            errors.push({
              message: `tile "${t.id}" declares input "${inp}" the cell ${t.type}:${op} does not read`,
              path: `tiles/${t.id}`,
            });
          }
        }
      }
    }
  }

  // --- nets resolve; build the this-frame dependency graph (skip :prev edges) ---
  // deps.get(B) = set of tile ids B reads THIS frame (for the topo sort).
  const deps = new Map<string, Set<string>>();
  for (const t of fabric.tiles) deps.set(t.id, new Set());
  // Track which inputs of each tile got driven (for "input has no net" hints).
  for (const [i, net] of fabric.nets.entries()) {
    const src = parseFrom(net.from);
    const dst = parseTo(net.to);
    // resolve source
    if (src.kind === 'iobIn') {
      // a valid IOB-in port name (membership already enforced by parse)
    } else if (src.kind === 'tile') {
      if (!tilesById.has(src.tileId)) {
        errors.push({ message: `net[${i}] from "${net.from}" references unknown tile`, path: `nets/${i}` });
      }
    } else {
      const reg = tilesById.get(src.tileId);
      if (!reg) {
        errors.push({ message: `net[${i}] from "${net.from}" references unknown register tile`, path: `nets/${i}` });
      } else if (reg.type !== 'reg') {
        errors.push({
          message: `net[${i}] from "${net.from}" uses ":prev" but tile "${src.tileId}" is type "${reg.type}", not a register`,
          path: `nets/${i}`,
        });
      }
    }
    // resolve dest
    if (dst.kind === 'out') {
      // OUT1/OUT2 — membership enforced by parse
    } else {
      const tile = tilesById.get(dst.tileId);
      if (!tile) {
        errors.push({ message: `net[${i}] to "${net.to}" references unknown tile`, path: `nets/${i}` });
      } else if (!dst.input) {
        errors.push({ message: `net[${i}] to "${net.to}" is missing an :<inputName>`, path: `nets/${i}` });
      } else if (isImplicitRegCapture(tile)) {
        // A register tile captures only its `a` input.
        if (dst.input !== REG_INPUT) {
          errors.push({
            message: `net[${i}] to "${net.to}" targets input "${dst.input}" — a register captures only "${REG_INPUT}"`,
            path: `nets/${i}`,
          });
        }
        if (src.kind === 'tile') deps.get(dst.tileId)!.add(src.tileId);
      } else {
        const cell = cellByTile.get(dst.tileId);
        if (cell && !cell.inputs.includes(dst.input)) {
          errors.push({
            message: `net[${i}] to "${net.to}" targets input "${dst.input}" the cell does not read`,
            path: `nets/${i}`,
          });
        }
        // record a this-frame dependency edge (NOT for :prev / IOB-in sources)
        if (src.kind === 'tile') deps.get(dst.tileId)!.add(src.tileId);
      }
    }
  }

  // --- combinational-cycle detection on the this-frame DAG ---
  const cyclePath = findCycle(deps);
  if (cyclePath) {
    errors.push({
      message:
        `combinational cycle: ${cyclePath.join(' -> ')} -> ${cyclePath[0]}. ` +
        `Feedback must pass through a register read ("<regId>:prev").`,
      path: `nets`,
    });
  }

  // --- outputs resolve ---
  const checkOutput = (which: 'vout1' | 'vout2', id: string | undefined) => {
    if (id === undefined) return;
    if ((VFPGA_IOB_OUT as readonly string[]).includes(id)) return; // OUT1/OUT2 IOB tile id
    if (!tilesById.has(id)) {
      errors.push({ message: `outputs.${which} "${id}" resolves to no tile/IOB-out`, path: `outputs/${which}` });
    }
  };
  checkOutput('vout1', fabric.outputs.vout1);
  checkOutput('vout2', fabric.outputs.vout2);

  // --- budget enforcement ---
  const budget = fabric.budget;
  if (budget) {
    if (budget.dsp !== undefined) {
      const dspCount = fabric.tiles.filter((t) => t.type === 'dsp').length;
      if (dspCount > budget.dsp) {
        errors.push({ message: `DSP budget exceeded: ${dspCount} dsp tiles > budget ${budget.dsp}`, path: `budget/dsp` });
      }
    }
    if (budget.bramRows !== undefined) {
      const bramRows = fabric.tiles
        .filter((t) => t.type === 'bram')
        .reduce((sum, t) => sum + (t.config.rows ?? 0), 0);
      if (bramRows > budget.bramRows) {
        errors.push({
          message: `BRAM-rows budget exceeded: ${bramRows} rows > budget ${budget.bramRows}`,
          path: `budget/bramRows`,
        });
      }
    }
    if (budget.passes !== undefined) {
      // pass count = the compute tiles (IOB tiles emit no pass of their own).
      const passCount = fabric.tiles.filter((t) => t.type !== 'iob_in' && t.type !== 'iob_out').length;
      if (passCount > budget.passes) {
        errors.push({
          message: `pass budget exceeded: ${passCount} passes > budget ${budget.passes}`,
          path: `budget/passes`,
        });
      }
    }
  }

  return errors;
}

/** DFS cycle finder over a `node → deps` graph. Returns one cycle's node list
 *  (in dependency order) or null. Only this-frame edges are present (`:prev`
 *  and IOB-in sources were never added), so any cycle here IS combinational. */
function findCycle(deps: Map<string, Set<string>>): string[] | null {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of deps.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GREY);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue; // unknown tile (already an error)
      const c = color.get(dep);
      if (c === GREY) {
        // back-edge → cycle from dep down to id
        const start = stack.indexOf(dep);
        return stack.slice(start);
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of deps.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// ----------------------------------------------------------------------
// Topological sort (combinational order) over the this-frame DAG.
// ----------------------------------------------------------------------

/** Kahn-ordered tile ids: a tile appears AFTER every tile it reads this frame
 *  (its inputs are ready). Deterministic: ties broken by the fabric tile order.
 *  Assumes the graph is acyclic (validated upstream). */
function topoSort(tiles: VfpgaTile[], deps: Map<string, Set<string>>): string[] {
  const order = new Map(tiles.map((t, i) => [t.id, i] as const));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep → tiles that read it
  for (const t of tiles) {
    indegree.set(t.id, deps.get(t.id)?.size ?? 0);
    dependents.set(t.id, []);
  }
  for (const t of tiles) {
    for (const dep of deps.get(t.id) ?? []) {
      dependents.get(dep)?.push(t.id);
    }
  }
  // ready = indegree 0, kept in fabric order for determinism
  const ready = tiles.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  ready.sort((a, b) => (order.get(a)! - order.get(b)!));
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    const newlyReady: string[] = [];
    for (const dep of dependents.get(id) ?? []) {
      const d = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, d);
      if (d === 0) newlyReady.push(dep);
    }
    newlyReady.sort((a, b) => (order.get(a)! - order.get(b)!));
    // merge newlyReady into ready preserving fabric order
    ready.push(...newlyReady);
    ready.sort((a, b) => (order.get(a)! - order.get(b)!));
  }
  return out;
}

// ----------------------------------------------------------------------
// fabricToEffect — the public P&R entry point.
// ----------------------------------------------------------------------

/** Compile a fabric configuration into a `VfpgaEffect` (the foundation render-
 *  graph the factory's `buildEffect` consumes). Pure + GL-free. Throws a
 *  {@link FabricCompileError} carrying every diagnostic if the fabric is
 *  structurally invalid (so the validation gate + the factory share one path). */
export function fabricToEffect(fabric: VfpgaFabric): VfpgaEffect {
  const errors = validateFabric(fabric);
  if (errors.length) throw new FabricCompileError(errors);

  const tilesById = new Map(fabric.tiles.map((t) => [t.id, t] as const));

  // --- this-frame dependency graph (skip :prev / IOB-in sources) ---
  const deps = new Map<string, Set<string>>();
  for (const t of fabric.tiles) deps.set(t.id, new Set());
  // For each (tileId, inputName) record the resolving source so we can emit the
  // sampler binding in step 5.
  const inputSource = new Map<string, ResolvedSource>(); // key `${tileId}:${input}`
  // For each OUT port, the tile that drives it.
  const outDriver = new Map<string, ResolvedSource>(); // OUT1/OUT2 → source
  for (const net of fabric.nets) {
    const src = parseFrom(net.from);
    const dst = parseTo(net.to);
    if (dst.kind === 'out') {
      outDriver.set(dst.port, src);
    } else {
      inputSource.set(`${dst.tileId}:${dst.input}`, src);
      if (src.kind === 'tile') deps.get(dst.tileId)!.add(src.tileId);
    }
  }

  // --- FBO ASSIGNMENT (step 4) ---
  // Each COMPUTE tile renders into its own FBO `fbo_<tileId>`. A register tile
  // gets a ping-pong PAIR (`fbo_<id>__a` / `fbo_<id>__b`); P0 emits both FBOs
  // and routes :prev reads to the back buffer (the swap itself is P1).
  const fbos: VfpgaFbo[] = [];
  const tileFboId = new Map<string, string>(); // compute tile → its WRITE fbo id
  const regBackFboId = new Map<string, string>(); // reg tile → its :prev (read) fbo id
  // Register ping-pong pairs the HOST swaps at end of frame (P1, design §4.3).
  const registers: VfpgaRegisterPair[] = [];
  for (const t of fabric.tiles) {
    if (t.type === 'iob_in' || t.type === 'iob_out') continue;
    const kind = t.config.kind === 'float' ? 'float' : 'rgba8';
    if (t.type === 'reg') {
      const front = `fbo_${t.id}__a`;
      const back = `fbo_${t.id}__b`;
      fbos.push({ id: front, kind }, { id: back, kind });
      tileFboId.set(t.id, front); // writes the front buffer this frame
      regBackFboId.set(t.id, back); // :prev reads the back buffer (last frame)
      registers.push({ id: t.id, front, back });
    } else {
      const id = `fbo_${t.id}`;
      fbos.push({ id, kind });
      tileFboId.set(t.id, id);
    }
  }

  /** The FBO id a resolved source's texture lives in (for an input sampler). An
   *  IOB-in maps onto the host vinN port id; a `:prev` reads a reg's back FBO; a
   *  plain tile reads its WRITE FBO. */
  function fboForSource(src: ResolvedSource): string {
    if (src.kind === 'iobIn') {
      // Only IIN ports are video samplers (CIN/GIN feed uniforms, not samplers).
      const vin = iobIinToVin(src.port);
      return vin ?? src.port; // CIN/GIN handled as uniforms elsewhere (later phases)
    }
    if (src.kind === 'regPrev') return regBackFboId.get(src.tileId)!;
    return tileFboId.get(src.tileId)!;
  }

  // --- resolve the surface 'output' target ---
  // The tile (or OUT IOB) feeding vout1 renders into the surface FBO 'output'
  // (so the foundation's surface.texture = vout1, unchanged). vout2 keeps its
  // own FBO and is read via read('outputTexture:vout2').
  const vout1TileId = resolveOutputTileId(fabric.outputs.vout1, outDriver, tilesById);
  const vout2TileId = fabric.outputs.vout2
    ? resolveOutputTileId(fabric.outputs.vout2, outDriver, tilesById)
    : null;

  // --- TOPO ORDER (steps 2/3 already validated acyclic) ---
  const computeTiles = fabric.tiles.filter((t) => t.type !== 'iob_in' && t.type !== 'iob_out');
  const order = topoSort(computeTiles, deps);

  // --- PASS EMISSION (step 5) ---
  const passes: VfpgaPass[] = [];

  /** Resolve a tile input's sampler binding via its driving net. An UNDRIVEN
   *  input binds the sentinel `__unpatched__`; the factory's textureForSource()
   *  falls back to its 1×1 transparent-black for any source that is neither a
   *  vinN port nor a declared fbo, so the shader never reads garbage. */
  const samplerFor = (tileId: string, input: string) => {
    const src = inputSource.get(`${tileId}:${input}`);
    return { source: src ? fboForSource(src) : '__unpatched__', uniform: cellInputUniform(input) };
  };

  for (const tileId of order) {
    const tile = tilesById.get(tileId)!;

    // The tile that drives vout1 renders straight into the surface 'output'.
    const target = tileId === vout1TileId ? 'output' : tileFboId.get(tileId)!;

    if (isImplicitRegCapture(tile)) {
      // A register is an implicit passthru capturing its `a` net into the front
      // buffer (the swap to the back buffer is P1). It reads no knobs.
      passes.push({
        frag: REG_CAPTURE_FRAG,
        inputs: [samplerFor(tileId, REG_INPUT)],
        target,
      });
      continue;
    }

    const cell = getCell(tile.type, tile.config.op ?? '');
    if (!cell) continue; // unreachable (validated), keeps TS happy

    // Resolve the knob → uniform names + the kernel source.
    const knobUniform = new Map(cell.knobs.map((k) => [k.name, k.uniform] as const));
    const frag = cell.kernel({
      uTexFor: (input) => cellInputUniform(input),
      uniformFor: (knob) => knobUniform.get(knob) ?? `u_${knob}`,
    });

    const inputs = cell.inputs.map((input) => samplerFor(tileId, input));

    // Uniform set: every knob uniform + the always-available uTime/uResolution.
    // (Bound p/cv/gate knobs surface through the foundation uniform-binding in a
    // later phase; P0 emits the knob uniform names so the factory sets consts.)
    const uniforms = cell.knobs.map((k) => k.uniform);

    passes.push({
      frag,
      inputs: inputs.length ? inputs : undefined,
      target,
      uniforms: uniforms.length ? uniforms : undefined,
    });
  }

  // The surface 'output' replaces vout1's own FBO — drop it from the FBO list so
  // we don't allocate a dead buffer (the foundation already owns 'output').
  const vout1WriteFbo = vout1TileId ? tileFboId.get(vout1TileId) : undefined;
  const liveFbos = fbos.filter((f) => f.id !== vout1WriteFbo);

  const vout1Id = 'output';
  const vout2Id = vout2TileId ? tileFboId.get(vout2TileId) : undefined;

  // Only swap register pairs whose BOTH buffers are real allocated FBOs. (A
  // register that itself drives vout1 has its front buffer replaced by the
  // surface 'output' — a degenerate config; we don't ping-pong the surface.)
  const liveFboIds = new Set(liveFbos.map((f) => f.id));
  const liveRegisters = registers.filter((r) => liveFboIds.has(r.front) && liveFboIds.has(r.back));

  return {
    passes,
    fbos: liveFbos.length ? liveFbos : undefined,
    outputs: vout2Id ? { vout1: vout1Id, vout2: vout2Id } : { vout1: vout1Id },
    ...(liveRegisters.length ? { registers: liveRegisters } : {}),
  };
}

/** Resolve an `outputs.voutN` reference (a tile id, or an OUT IOB-out tile id
 *  whose single net's source tile we follow) to the COMPUTE tile whose FBO the
 *  vout samples. */
function resolveOutputTileId(
  ref: string,
  outDriver: Map<string, ResolvedSource>,
  tilesById: Map<string, VfpgaTile>,
): string | null {
  const tile = tilesById.get(ref);
  if (tile && tile.type === 'iob_out') {
    // An iob_out tile: follow the OUT port net to its driving compute tile.
    const port = tile.config.op ?? '';
    const src = outDriver.get(port);
    if (src && (src.kind === 'tile' || src.kind === 'regPrev')) return src.tileId;
    return null;
  }
  // A direct OUT port name in outputs (OUT1/OUT2) → its net's driver.
  if ((VFPGA_IOB_OUT as readonly string[]).includes(ref)) {
    const src = outDriver.get(ref);
    if (src && (src.kind === 'tile' || src.kind === 'regPrev')) return src.tileId;
    return null;
  }
  // Otherwise a direct compute-tile id.
  return tile ? tile.id : null;
}
