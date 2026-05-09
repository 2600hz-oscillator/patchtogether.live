// packages/web/src/lib/livecode/evaluator.ts
//
// LIVECODE DSL evaluator. Walks the parsed AST, asks the registries +
// the live patch graph what's legal, and emits a list of mutations
// (spawn / patch / setParam / setData) that the host wraps in a single
// `ydoc.transact`. Transactionality means a mid-script error rolls back
// the whole thing — the host buffers the mutation list, applies it
// atomically only after the entire script type-checks.
//
// Symbol resolution:
//   - Local variables introduced via `x = foo.new()` live in `scope`.
//   - Pre-existing modules in the rack are addressable by their
//     `node.data.name` (case-insensitive). E.g. `ANALOGVCO1.frequency = 440`
//     looks up the live node by name and writes to its params.
//
// What this file is NOT:
//   - It does not call into the audio engine. Mutations land on the
//     SyncedStore patch graph; the reconciler picks them up next tick.
//   - It does not own the textarea / UI — that lives in LivecodeCard.svelte.

import type { ModuleNode, Edge, ModuleType, CableType } from '$lib/graph/types';
import { canConnect } from '$lib/graph/types';
import { getModuleDef, listModuleDefs } from '$lib/audio/module-registry';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
// Force-import the per-domain module registries so DSL lookups resolve
// regardless of which chunk loads first under code-splitting. Both
// modules' top-level side effects register their module defs into the
// shared registry; without these imports a prerendered bundle could ship
// LivecodeCard in a chunk that boots before audio/modules has run, and
// `getModuleDef('analogVco')` would return undefined.
import '$lib/audio/modules';
import '$lib/video/modules';
import { findNodeByName, nextDefaultName } from '$lib/multiplayer/module-naming';
import { parse, DslError, type Program, type Stmt, type Expr, type Pos } from './parser';

/** A patchable module def — either audio or video flavor. The fields the
 *  evaluator needs are common to both. */
interface PortLike {
  id: string;
  type: CableType;
}
interface ParamLike {
  id: string;
}
interface DefLike {
  type: ModuleType;
  domain: 'audio' | 'video';
  inputs: readonly PortLike[];
  outputs: readonly PortLike[];
  params: readonly ParamLike[];
}

/** Mutation primitives the evaluator emits. The host applies them in
 *  order inside a single ydoc.transact. */
export type Mutation =
  | { kind: 'spawnNode'; node: ModuleNode }
  | { kind: 'addEdge'; edge: Edge }
  | { kind: 'setParam'; nodeId: string; paramId: string; value: number }
  | { kind: 'setData'; nodeId: string; key: string; value: unknown };

export interface EvaluateInput {
  /** Source DSL text. */
  src: string;
  /** Snapshot of the current rack (read-only — evaluator never mutates this). */
  liveNodes: Record<string, ModuleNode | undefined>;
  /** Snapshot of current edges (read-only). Used so we don't double-add. */
  liveEdges: Record<string, Edge | undefined>;
  /** Optional spawn position — defaults to (60, 60). The evaluator stamps
   *  this on every spawned node; collisions are not auto-resolved (host
   *  can run organize-modules afterward). Each spawn nudges by 24px so
   *  consecutive spawns don't pile up. */
  spawnOrigin?: { x: number; y: number };
  /** When the host wants spawn ids tied to a deterministic prefix (tests),
   *  pass an idAllocator. Default: crypto.randomUUID(). */
  allocateId?: (type: ModuleType) => string;
}

/** Per-script log line — the host displays these in the card's "output" pane. */
export interface LogLine {
  message: string;
}

export type EvaluateResult =
  | {
      ok: true;
      mutations: Mutation[];
      log: LogLine[];
    }
  | {
      ok: false;
      error: { message: string; line: number; col: number };
      partialLog: LogLine[];
    };

/**
 * Top-level evaluator. Parses + evaluates; never throws (errors come back
 * via the result object). The host calls this OUTSIDE a transact, then
 * runs the returned mutations inside one if `ok`.
 */
export function evaluate(input: EvaluateInput): EvaluateResult {
  let program: Program;
  try {
    program = parse(input.src);
  } catch (e) {
    if (e instanceof DslError) {
      return { ok: false, error: { message: e.message.replace(/^\d+:\d+:\s*/, ''), line: e.line, col: e.col }, partialLog: [] };
    }
    return { ok: false, error: { message: String(e), line: 1, col: 1 }, partialLog: [] };
  }

  const ev = new Evaluator(input);
  try {
    for (const stmt of program.statements) {
      ev.evalStmt(stmt);
    }
    return { ok: true, mutations: ev.mutations, log: ev.log };
  } catch (e) {
    if (e instanceof DslError) {
      return { ok: false, error: { message: e.message.replace(/^\d+:\d+:\s*/, ''), line: e.line, col: e.col }, partialLog: ev.log };
    }
    return { ok: false, error: { message: String(e), line: 1, col: 1 }, partialLog: ev.log };
  }
}

class Evaluator {
  /** Variables introduced by `x = foo.new()` or `x = some_existing_name`.
   *  Keys are the lowercase variable names. Values are the node id of the
   *  bound module. */
  private scope = new Map<string, string>();

  /** Live snapshot taken at the start of evaluation. We DO mutate a shadow
   *  to track names / params we've added during this script (so a later
   *  `nextDefaultName` accounts for spawns earlier in the same script).
   *  We never mutate the caller's `liveNodes` map. */
  private workingNodes: Record<string, ModuleNode> = {};
  private workingEdges: Record<string, Edge> = {};

  mutations: Mutation[] = [];
  log: LogLine[] = [];
  private spawnIndex = 0;
  private input: EvaluateInput;

  constructor(input: EvaluateInput) {
    this.input = input;
    // Deep-copy live state into our working sets so spawn-naming sees
    // nodes added earlier in the same script.
    for (const [id, n] of Object.entries(input.liveNodes)) {
      if (n) this.workingNodes[id] = { ...n, data: n.data ? { ...n.data } : undefined, params: { ...n.params } };
    }
    for (const [id, e] of Object.entries(input.liveEdges)) {
      if (e) this.workingEdges[id] = { ...e };
    }
  }

  evalStmt(stmt: Stmt): void {
    if (stmt.kind === 'assign') return this.evalAssign(stmt);
    if (stmt.kind === 'patch') return this.evalPatch(stmt);
  }

  // ---------------- Assign ----------------

  private evalAssign(stmt: Stmt & { kind: 'assign' }): void {
    if (stmt.target.kind === 'ident') {
      // x = expr — the only valid expr-on-RHS is a spawn (`foo.new()`) or
      // a reference to an existing module name. Numbers/notes/arrays here
      // would be a no-op and we reject them.
      const name = stmt.target.name;
      const v = stmt.value;
      if (v.kind === 'spawn') {
        const nodeId = this.spawnNode(v.moduleType, v.pos);
        this.scope.set(name.toLowerCase(), nodeId);
        return;
      }
      if (v.kind === 'ident') {
        // Bind a local variable to an existing module by name.
        const node = this.lookupModule(v.name, v.pos);
        this.scope.set(name.toLowerCase(), node.id);
        return;
      }
      throw new DslError(
        `Right side of variable assignment must be '<type>.new()' or another module name`,
        stmt.pos.line,
        stmt.pos.col,
      );
    }
    // Member assignment: x.frequency = 440 OR x.track1 = [c3, ...]
    const obj = this.lookupTarget(stmt.target.object, stmt.target.pos);
    const def = this.requireDef(obj, stmt.target.pos);
    const member = stmt.target.member;
    // Param vs data-array decision:
    //   - If def.params has a matching id AND the value is a number/note,
    //     it's a setParam.
    //   - If the value is an array, it's stored on node.data[member]. The
    //     reconciler / module-specific code interprets array data fields
    //     (e.g. drumseqz tracks live in node.data.tracks).
    //   - Otherwise we throw.
    if (stmt.value.kind === 'array') {
      // Array assignments always land on node.data.
      const items = stmt.value.items.map((it) => this.evalArrayItem(it));
      this.mutations.push({
        kind: 'setData',
        nodeId: obj.id,
        key: member,
        value: items,
      });
      // Mirror in our working snapshot.
      if (!obj.data) obj.data = {};
      obj.data[member] = items;
      this.log.push({ message: `set ${this.displayName(obj)}.${member} = [${items.length} items]` });
      return;
    }
    // Number / note → setParam.
    const value = this.evalExprToNumber(stmt.value);
    const paramDef = def.params.find((p) => p.id === member);
    if (!paramDef) {
      // We don't know if `member` is a real param / data field on this
      // module — it might be a per-module data field (e.g. score's
      // sequence). For now we accept ANY number assignment as a setParam
      // so users can write `seq.bpm = 120` even if the module's def
      // didn't declare bpm as a fader-driven param. This matches the
      // store-level shape (params is `Record<string, number>`).
      this.mutations.push({
        kind: 'setParam',
        nodeId: obj.id,
        paramId: member,
        value,
      });
      obj.params[member] = value;
      this.log.push({ message: `set ${this.displayName(obj)}.${member} = ${value}` });
      return;
    }
    this.mutations.push({
      kind: 'setParam',
      nodeId: obj.id,
      paramId: member,
      value,
    });
    obj.params[member] = value;
    this.log.push({ message: `set ${this.displayName(obj)}.${member} = ${value}` });
  }

  // ---------------- Patch ----------------

  private evalPatch(stmt: Stmt & { kind: 'patch' }): void {
    const src = this.lookupTarget(stmt.from.object, stmt.from.pos);
    const dst = this.lookupTarget(stmt.to.object, stmt.to.pos);
    const srcDef = this.requireDef(src, stmt.from.pos);
    const dstDef = this.requireDef(dst, stmt.to.pos);
    const srcPort = srcDef.outputs.find((p) => p.id === stmt.from.member);
    if (!srcPort) {
      throw new DslError(
        `'${this.displayName(src)}' has no output port '${stmt.from.member}'. ` +
          `Available outputs: ${srcDef.outputs.map((p) => p.id).join(', ') || '(none)'}`,
        stmt.from.pos.line,
        stmt.from.pos.col,
      );
    }
    const dstPort = dstDef.inputs.find((p) => p.id === stmt.to.member);
    if (!dstPort) {
      throw new DslError(
        `'${this.displayName(dst)}' has no input port '${stmt.to.member}'. ` +
          `Available inputs: ${dstDef.inputs.map((p) => p.id).join(', ') || '(none)'}`,
        stmt.to.pos.line,
        stmt.to.pos.col,
      );
    }
    if (!canConnect(srcPort.type, dstPort.type)) {
      throw new DslError(
        `Cannot connect ${srcPort.type} to ${dstPort.type} ` +
          `(${this.displayName(src)}.${srcPort.id} → ${this.displayName(dst)}.${dstPort.id})`,
        stmt.from.pos.line,
        stmt.from.pos.col,
      );
    }
    const id = `e-${src.id}-${srcPort.id}-${dst.id}-${dstPort.id}`;
    if (this.workingEdges[id]) {
      this.log.push({ message: `patched ${this.displayName(src)}.${srcPort.id} -> ${this.displayName(dst)}.${dstPort.id} (already exists, skipping)` });
      return;
    }
    const edge: Edge = {
      id,
      source: { nodeId: src.id, portId: srcPort.id },
      target: { nodeId: dst.id, portId: dstPort.id },
      sourceType: srcPort.type,
      targetType: dstPort.type,
    };
    this.mutations.push({ kind: 'addEdge', edge });
    this.workingEdges[id] = edge;
    this.log.push({ message: `patched ${this.displayName(src)}.${srcPort.id} -> ${this.displayName(dst)}.${dstPort.id}` });
  }

  // ---------------- Spawn ----------------

  private spawnNode(typeRaw: string, pos: Pos): string {
    const type = typeRaw.toLowerCase();
    // Identify the registered def by case-insensitive type lookup. Module
    // type ids are conventionally camelCase but the DSL uses lowercase
    // user-friendly names (analogvco, drumseqz, etc.) so we match
    // case-insensitively across both registries.
    const def = this.findDefByLooseType(type);
    if (!def) {
      throw new DslError(
        `Unknown module type '${typeRaw}'. ` +
          `Try one of: ${this.allTypes().slice(0, 8).join(', ')}…`,
        pos.line,
        pos.col,
      );
    }
    const id = this.input.allocateId
      ? this.input.allocateId(def.type)
      : `${String(def.type)}-${cryptoRandomShort()}`;
    const name = nextDefaultName(this.workingNodes, def.type);
    const origin = this.input.spawnOrigin ?? { x: 60, y: 60 };
    const STACK = 24;
    const position = {
      x: origin.x + this.spawnIndex * STACK,
      y: origin.y + this.spawnIndex * STACK,
    };
    this.spawnIndex++;
    const node: ModuleNode = {
      id,
      type: def.type,
      domain: def.domain,
      position,
      params: {},
      data: { name },
    };
    this.mutations.push({ kind: 'spawnNode', node });
    this.workingNodes[id] = { ...node, params: { ...node.params }, data: { ...node.data } };
    this.log.push({ message: `spawned ${name} (${String(def.type)})` });
    return id;
  }

  // ---------------- Lookup helpers ----------------

  /**
   * Resolve an identifier on the LHS of `.<member>` (assign target or
   * patch endpoint) to a live ModuleNode. Tries:
   *   1. Local scope (this script's variables)
   *   2. Live module-name lookup (case-insensitive node.data.name match)
   * If neither matches → throw.
   */
  private lookupTarget(name: string, pos: Pos): ModuleNode {
    const local = this.scope.get(name.toLowerCase());
    if (local) {
      const node = this.workingNodes[local];
      if (!node) {
        throw new DslError(
          `Internal: variable '${name}' was bound to a node id that doesn't exist`,
          pos.line,
          pos.col,
        );
      }
      return node;
    }
    return this.lookupModule(name, pos);
  }

  /** Resolve by name only (no scope); throws if not found. */
  private lookupModule(name: string, pos: Pos): ModuleNode {
    const node = findNodeByName(this.workingNodes, name);
    if (!node) {
      throw new DslError(
        `Unknown variable or module '${name}'. ` +
          `Define it earlier in the script (e.g. '${name.toLowerCase()} = vca.new()') or reference an existing module by its name (e.g. ANALOGVCO1).`,
        pos.line,
        pos.col,
      );
    }
    return node;
  }

  private requireDef(node: ModuleNode, pos: Pos): DefLike {
    const audio = getModuleDef(node.type);
    if (audio) {
      return {
        type: audio.type,
        domain: 'audio',
        inputs: audio.inputs as readonly PortLike[],
        outputs: audio.outputs as readonly PortLike[],
        params: audio.params,
      };
    }
    const video = getVideoModuleDef(node.type);
    if (video) {
      return {
        type: video.type,
        domain: 'video',
        inputs: video.inputs as readonly PortLike[],
        outputs: video.outputs as readonly PortLike[],
        params: video.params,
      };
    }
    throw new DslError(
      `Module type '${String(node.type)}' is not registered`,
      pos.line,
      pos.col,
    );
  }

  private findDefByLooseType(typeLower: string): DefLike | undefined {
    for (const def of listModuleDefs()) {
      if (String(def.type).toLowerCase() === typeLower) {
        return {
          type: def.type,
          domain: 'audio',
          inputs: def.inputs as readonly PortLike[],
          outputs: def.outputs as readonly PortLike[],
          params: def.params,
        };
      }
    }
    for (const def of listVideoModuleDefs()) {
      if (String(def.type).toLowerCase() === typeLower) {
        return {
          type: def.type,
          domain: 'video',
          inputs: def.inputs as readonly PortLike[],
          outputs: def.outputs as readonly PortLike[],
          params: def.params,
        };
      }
    }
    return undefined;
  }

  private allTypes(): string[] {
    return [
      ...listModuleDefs().map((d) => String(d.type).toLowerCase()),
      ...listVideoModuleDefs().map((d) => String(d.type).toLowerCase()),
    ].sort();
  }

  // ---------------- Expression evaluation ----------------

  private evalExprToNumber(e: Expr): number {
    if (e.kind === 'number') return e.value;
    if (e.kind === 'note') return noteToMidi(e.value, e.pos);
    if (e.kind === 'empty') return -1;
    throw new DslError(
      `Expected a number or note, got ${e.kind}`,
      e.pos.line,
      e.pos.col,
    );
  }

  /** Convert an array-item expression to a serializable value. Arrays
   *  storing sequencer steps want either {on:false,midi:null} for the `-`
   *  marker or {on:true, midi:N} for a note; storing a plain number is
   *  also useful for raw param-arrays. */
  private evalArrayItem(e: Expr): unknown {
    if (e.kind === 'empty') return { on: false, midi: null };
    if (e.kind === 'note') return { on: true, midi: noteToMidi(e.value, e.pos) };
    if (e.kind === 'number') return e.value;
    if (e.kind === 'ident') {
      // Bare ident inside an array — treat as a node-name reference and
      // return its midi-like binding if we can. v1 keeps it simple: error
      // so users can't accidentally write `[c3, foo, c4]` and silently
      // store an undefined value.
      throw new DslError(
        `Bare identifier '${e.name}' is not allowed inside an array; use a note (e.g. c3) or '-' for an empty step`,
        e.pos.line,
        e.pos.col,
      );
    }
    throw new DslError(
      `Unsupported array item kind: ${e.kind}`,
      e.pos.line,
      e.pos.col,
    );
  }

  private displayName(node: ModuleNode): string {
    return (node.data?.name as string | undefined) ?? node.id;
  }
}

// ---------------- Helpers ----------------

/**
 * Convert a parsed note literal to MIDI. Accepts both `c3` and `c3#`
 * orderings; case-insensitive. Octave is the FOLLOWING integer (so c4 is
 * MIDI 60, a4 is 69). Sharps/flats nudge ±1 semitone.
 *
 * Throws DslError on out-of-range octave or unknown letter (defensive —
 * the parser's note pattern already restricts to [a-g]).
 */
export function noteToMidi(text: string, pos: Pos): number {
  const m = /^([a-g])([b#]?)(\d+)([b#]?)$/i.exec(text);
  if (!m) {
    throw new DslError(`Invalid note literal: ${text}`, pos.line, pos.col);
  }
  const letter = m[1]!.toLowerCase();
  const acc1 = m[2]!;
  const oct = Number(m[3]!);
  const acc2 = m[4]!;
  if (acc1 && acc2) {
    throw new DslError(`Note '${text}' has two accidentals`, pos.line, pos.col);
  }
  const accidental = acc1 || acc2;
  const semitone: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let s = semitone[letter];
  if (s === undefined) {
    throw new DslError(`Unknown note letter: ${letter}`, pos.line, pos.col);
  }
  if (accidental === '#') s += 1;
  else if (accidental === 'b') s -= 1;
  // MIDI: c-1 = 0, c0 = 12, c4 = 60.
  return s + (oct + 1) * 12;
}

function cryptoRandomShort(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  // Fallback for node-test envs without crypto (vitest jsdom has it; node has it too).
  return Math.random().toString(36).slice(2, 10);
}
