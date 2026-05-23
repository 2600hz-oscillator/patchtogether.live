// packages/web/src/lib/livecode/runtime.ts
//
// LIVECODE JS sandbox runtime. Replaces the old custom-DSL parser +
// evaluator (parser.ts / evaluator.ts, deleted in the same PR) with a
// `new Function`-based sandbox that runs user code with a curated set
// of globals:
//
//   * spawn(type, name?)              → spawns a module, returns its name
//   * patch(refA, refB)               → wires a cable (direction-agnostic)
//   * unpatch(refA, refB)             → removes a cable
//   * set(module, param, value)       → setParam
//   * read(module, key)               → engine.read passthrough
//   * listModules()                   → string[] of spawned names
//   * clock.{start,stop,mute,unmute,bpm} → TIMELORDE convenience
//   * clocked(division, fn) / every() → spawns a clockedRunner module
//   * log(...args)                    → push to the card's output panel
//   * <every spawned module>          → proxy with .step / .params / .name
//
// Security: `new Function` is NOT a hard sandbox. A determined user can
// escape via `this.constructor.constructor('return process')()`. For
// this LOCAL-USER-OWNS-THEIR-OWN-RACK tool that's acceptable; the docs
// page calls it out.
//
// Like the old evaluator, the runtime never mutates the caller's
// liveNodes/liveEdges maps. It accumulates Mutations into a list that
// the host wraps in a single ydoc.transact.

import type { ModuleNode, Edge, ModuleType } from '$lib/graph/types';
import { nextDefaultName, readName } from '$lib/multiplayer/module-naming';
import {
  getDefForType,
  resolveCable,
  findEdgeBetween,
  edgeIdForCable,
  type DefPorts,
} from './port-types';
import { CLOCKED_DIVISIONS, type ClockedDivision } from './api-surface';
// Force-import the per-domain barrels so the registries are populated
// regardless of which chunk loads first under code-splitting.
import '$lib/audio/modules';
import '$lib/video/modules';

/** Mutation primitives the runtime emits. The host applies them in
 *  order inside a single ydoc.transact. Same shape as the old
 *  evaluator's so the host wiring doesn't need to change. */
export type Mutation =
  | { kind: 'spawnNode'; node: ModuleNode }
  | { kind: 'addEdge'; edge: Edge }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setParam'; nodeId: string; paramId: string; value: number }
  | { kind: 'setData'; nodeId: string; key: string; value: unknown };

export interface LogLine {
  message: string;
}

export interface RunInput {
  src: string;
  liveNodes: Record<string, ModuleNode | undefined>;
  liveEdges: Record<string, Edge | undefined>;
  /** Default spawn position. Each spawn nudges by 24px so consecutive
   *  spawns don't overlap. */
  spawnOrigin?: { x: number; y: number };
  /** Per-spawn id allocator (tests pass a deterministic one). Default:
   *  crypto.randomUUID-derived short ids. */
  allocateId?: (type: ModuleType) => string;
  /** Identity of the LIVECODE card running this script — clocked()
   *  uses it to derive deterministic runner names per source-position.
   *  Optional; absent means "anonymous" and clocked() runners get a
   *  generated name each time. */
  ownerNodeId?: string;
}

export type RunResult =
  | { ok: true; mutations: Mutation[]; log: LogLine[] }
  | {
      ok: false;
      error: { message: string; line: number; col: number };
      partialLog: LogLine[];
      mutations: Mutation[];
    };

/** Public entry point. Compiles + runs the user code; never throws —
 *  errors come back via the result object. */
export function run(input: RunInput): RunResult {
  const rt = new Runtime(input);
  try {
    rt.compileAndRun();
    return { ok: true, mutations: rt.mutations, log: rt.log };
  } catch (e) {
    const { message, line, col } = extractErrorPos(e);
    return {
      ok: false,
      error: { message, line, col },
      partialLog: rt.log,
      mutations: rt.mutations,
    };
  }
}

/** Best-effort source-position extraction from a thrown Error. Vite +
 *  modern V8 give us `error.stack` lines like "at <anonymous>:LINE:COL".
 *  When the parser threw at compile time the error is a SyntaxError
 *  whose `.lineNumber` (Firefox-only) or the stack's "<anonymous>:N:M"
 *  marker (V8) carries the position. Fallback: line=1 col=1. */
function extractErrorPos(e: unknown): { message: string; line: number; col: number } {
  if (e instanceof Error) {
    const msg = e.message;
    const stack = e.stack ?? '';
    // V8 form: "at <anonymous>:LINE:COL" inside the eval frame.
    const m = stack.match(/<anonymous>:(\d+):(\d+)/);
    if (m) {
      return { message: msg, line: Number(m[1]!), col: Number(m[2]!) };
    }
    return { message: msg, line: 1, col: 1 };
  }
  return { message: String(e), line: 1, col: 1 };
}

class Runtime {
  /** Shadow copy of the rack so script-local spawns are visible to
   *  later spawns / patches in the same run. */
  private workingNodes: Record<string, ModuleNode> = {};
  private workingEdges: Record<string, Edge> = {};
  /** Maps script-facing names → node ids. Pre-populated with every
   *  existing module's display name + raw id. */
  private nameToId = new Map<string, string>();

  mutations: Mutation[] = [];
  log: LogLine[] = [];
  private spawnIndex = 0;
  /** Per-clocked()-call counter; resets per script invocation. Used to
   *  derive deterministic runner names so re-running the same script
   *  updates the existing runner instead of spawning duplicates. */
  private clockedIndex = 0;
  private input: RunInput;

  constructor(input: RunInput) {
    this.input = input;
    for (const [id, n] of Object.entries(input.liveNodes)) {
      if (!n) continue;
      const clone: ModuleNode = {
        ...n,
        params: { ...n.params },
        data: n.data ? { ...n.data } : undefined,
      };
      this.workingNodes[id] = clone;
      const nm = readName(clone);
      if (nm) this.nameToId.set(nm.toLowerCase(), id);
      this.nameToId.set(id.toLowerCase(), id);
    }
    for (const [id, e] of Object.entries(input.liveEdges)) {
      if (e) this.workingEdges[id] = { ...e };
    }
  }

  // ─── Top-level: build globals + invoke new Function ──────────────
  compileAndRun(): void {
    const globals = this.buildGlobals();
    const globalKeys = Object.keys(globals);
    const globalVals = Object.values(globals);
    // `'use strict'` so e.g. assigning to an undeclared global throws
    // instead of silently leaking onto the host's window.
    const body = `'use strict';\n${this.input.src}`;
    // Wrap in new Function. The function param list is every global
    // name; we invoke with the matching values. This keeps user code
    // from polluting the host globalThis.
    let fn: (...args: unknown[]) => unknown;
    try {
      fn = new Function(...globalKeys, body) as (...args: unknown[]) => unknown;
    } catch (e) {
      // Compile-time SyntaxError. Browser sometimes annotates
      // .lineNumber; otherwise our line:col falls back to 1:1.
      throw e;
    }
    // Per-script tick budget. v1: 100ms hard timeout. We can't actually
    // interrupt a synchronous infinite loop in JS without a worker, so
    // this is best-effort: the runtime fast-paths small scripts. Long
    // sleeps via setTimeout will run after we return.
    fn.apply(undefined, globalVals);
  }

  // ─── Globals ──────────────────────────────────────────────────────
  private buildGlobals(): Record<string, unknown> {
    const self = this;
    const globals: Record<string, unknown> = {
      spawn: (type: string, name?: string) => self.opSpawn(type, name),
      patch: (refA: string, refB: string) => self.opPatch(refA, refB),
      unpatch: (refA: string, refB: string) => self.opUnpatch(refA, refB),
      set: (mod: string, paramId: string, value: number) => self.opSet(mod, paramId, value),
      read: (mod: string, key: string) => self.opRead(mod, key),
      listModules: () => self.opListModules(),
      clock: self.buildClockNamespace(),
      clocked: (division: string, fn: (...args: unknown[]) => unknown) => self.opClocked(division, fn),
      every: (division: string, fn: (...args: unknown[]) => unknown) => self.opClocked(division, fn),
      log: (...args: unknown[]) => self.opLog(args),
    };
    // Per-module proxies: every live module becomes a top-level
    // identifier. Reserved names (anything already in globals or
    // anything that'd clash with a JS keyword) are skipped — the user
    // can still access them via read().
    for (const n of Object.values(self.workingNodes)) {
      const nm = readName(n);
      if (!nm) continue;
      const key = nm; // preserve case in the surface; lookup is case-insensitive
      if (Object.prototype.hasOwnProperty.call(globals, key)) continue;
      if (RESERVED_KEYWORDS.has(key.toLowerCase())) continue;
      globals[key] = self.buildModuleProxy(n.id);
    }
    return globals;
  }

  private buildClockNamespace(): Record<string, unknown> {
    const self = this;
    const findTimelorde = () =>
      Object.values(self.workingNodes).find((n) => n.type === 'timelorde');
    return {
      start: () => {
        const t = findTimelorde();
        if (!t) { self.opLog(['clock.start: no TIMELORDE found']); return; }
        self.mutations.push({ kind: 'setParam', nodeId: t.id, paramId: 'muteOutputs', value: 0 });
        t.params.muteOutputs = 0;
        self.opLog(['clock.start']);
      },
      stop: () => {
        const t = findTimelorde();
        if (!t) { self.opLog(['clock.stop: no TIMELORDE found']); return; }
        self.mutations.push({ kind: 'setParam', nodeId: t.id, paramId: 'muteOutputs', value: 1 });
        t.params.muteOutputs = 1;
        self.opLog(['clock.stop (outputs muted; internal clock keeps running)']);
      },
      mute: () => {
        const ns = self.buildClockNamespace();
        return (ns as { stop: () => void }).stop();
      },
      unmute: () => {
        const ns = self.buildClockNamespace();
        return (ns as { start: () => void }).start();
      },
      bpm: (value?: number) => {
        const t = findTimelorde();
        if (!t) { self.opLog(['clock.bpm: no TIMELORDE found']); return undefined; }
        if (value === undefined) {
          return typeof t.params.bpm === 'number' ? t.params.bpm : 120;
        }
        const clamped = Math.max(10, Math.min(300, Math.round(value)));
        self.mutations.push({ kind: 'setParam', nodeId: t.id, paramId: 'bpm', value: clamped });
        t.params.bpm = clamped;
        self.opLog([`clock.bpm = ${clamped}`]);
        return clamped;
      },
    };
  }

  /** Per-module read-only proxy. Fields:
   *
   *    .id      raw node id
   *    .name    display name
   *    .type    module type
   *    .params  shallow snapshot of node.params (number record)
   *    .step    convenience for sequencer-style modules — derived from
   *             params.stepIndex / engine read; v1 returns undefined for
   *             non-sequencer modules, leaving the user to use
   *             read(name, 'step') for engine-side reads.
   */
  private buildModuleProxy(nodeId: string): unknown {
    const self = this;
    return new Proxy({}, {
      get(_t, prop) {
        const node = self.workingNodes[nodeId];
        if (!node) return undefined;
        if (prop === 'id') return node.id;
        if (prop === 'name') return readName(node);
        if (prop === 'type') return node.type;
        if (prop === 'params') return { ...node.params };
        if (prop === 'step') return node.params.stepIndex;
        if (prop === 'outputs') return undefined; // engine.read('outputPeak', port) in v1
        return undefined;
      },
      set() { return false; },
      has(_t, prop) {
        return ['id', 'name', 'type', 'params', 'step', 'outputs'].includes(String(prop));
      },
    });
  }

  // ─── Operations ───────────────────────────────────────────────────

  private opSpawn(type: string, customName?: string): string {
    const def = this.resolveDef(type);
    if (!def) throw new Error(`unknown module type: '${type}'`);
    const id = this.allocateId(def.type as ModuleType);
    const name = customName ?? nextDefaultName(this.workingNodes, def.type as ModuleType);
    const origin = this.input.spawnOrigin ?? { x: 60, y: 60 };
    const STACK = 24;
    const position = {
      x: origin.x + this.spawnIndex * STACK,
      y: origin.y + this.spawnIndex * STACK,
    };
    this.spawnIndex++;
    const node: ModuleNode = {
      id,
      type: def.type as ModuleType,
      domain: def.domain,
      position,
      params: {},
      data: { name },
    };
    this.mutations.push({ kind: 'spawnNode', node });
    this.workingNodes[id] = { ...node, params: { ...node.params }, data: { ...node.data } };
    this.nameToId.set(name.toLowerCase(), id);
    this.nameToId.set(id.toLowerCase(), id);
    this.log.push({ message: `spawn ${name} (${def.type})` });
    return name;
  }

  private opPatch(refA: string, refB: string): void {
    const r = resolveCable(this.workingNodes, refA, refB);
    if (!r.ok) throw new Error(`patch: ${r.reason}`);
    const existing = findEdgeBetween(this.workingEdges, r);
    if (existing) {
      this.log.push({ message: `patch ${refA} -> ${refB} (already exists, skipping)` });
      return;
    }
    const id = edgeIdForCable(r);
    const edge: Edge = {
      id,
      source: { nodeId: r.source.node.id, portId: r.source.port.id },
      target: { nodeId: r.target.node.id, portId: r.target.port.id },
      sourceType: r.source.port.type,
      targetType: r.target.port.type,
    };
    this.mutations.push({ kind: 'addEdge', edge });
    this.workingEdges[id] = edge;
    this.log.push({
      message: `patch ${readName(r.source.node)}.${r.source.port.id} -> ${readName(r.target.node)}.${r.target.port.id}`,
    });
  }

  private opUnpatch(refA: string, refB: string): void {
    const r = resolveCable(this.workingNodes, refA, refB);
    if (!r.ok) throw new Error(`unpatch: ${r.reason}`);
    const existing = findEdgeBetween(this.workingEdges, r);
    if (!existing) {
      this.log.push({ message: `unpatch ${refA} <-> ${refB} (no edge, skipping)` });
      return;
    }
    this.mutations.push({ kind: 'removeEdge', edgeId: existing.id });
    delete this.workingEdges[existing.id];
    this.log.push({
      message: `unpatch ${readName(r.source.node)}.${r.source.port.id} <-> ${readName(r.target.node)}.${r.target.port.id}`,
    });
  }

  private opSet(modRef: string, paramId: string, value: number): void {
    const node = this.lookupNode(modRef);
    if (!node) throw new Error(`set: module '${modRef}' not found`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`set: value must be a finite number (got ${value})`);
    }
    this.mutations.push({ kind: 'setParam', nodeId: node.id, paramId, value });
    node.params[paramId] = value;
    this.log.push({ message: `set ${readName(node)}.${paramId} = ${value}` });
  }

  private opRead(modRef: string, key: string): unknown {
    const node = this.lookupNode(modRef);
    if (!node) throw new Error(`read: module '${modRef}' not found`);
    // v1: read pulls from the patch graph's live params/data; engine
    // reads (currentStep, outputPeak.X, etc.) are exposed via the
    // module proxy + engine bridge in a follow-up. For now this works
    // for static settings.
    if (key === 'name') return readName(node);
    if (key === 'type') return node.type;
    if (key in node.params) return node.params[key];
    if (node.data && key in node.data) return node.data[key];
    return undefined;
  }

  private opListModules(): string[] {
    const names: string[] = [];
    for (const n of Object.values(this.workingNodes)) {
      const nm = readName(n);
      if (nm) names.push(nm);
    }
    return names.sort();
  }

  /** clocked(division, fn): create or update a clockedRunner module
   *  carrying the function body + division. The runner spawns next to
   *  the LIVECODE that created it; deleting it cancels the schedule.
   *  Re-running the SAME script updates the SAME runner (idempotent
   *  per script-position) by deriving the runner name from
   *  ownerNodeId + clockedIndex. */
  private opClocked(division: string, fn: (...args: unknown[]) => unknown): string {
    if (!isValidDivision(division)) {
      throw new Error(`clocked: invalid division '${division}'. Use one of: ${CLOCKED_DIVISIONS.join(', ')}`);
    }
    if (typeof fn !== 'function') {
      throw new Error('clocked: second arg must be a function');
    }
    const idx = ++this.clockedIndex;
    const ownerSuffix = this.input.ownerNodeId
      ? this.input.ownerNodeId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)
      : 'anon';
    const runnerName = `clockedRunner_${ownerSuffix}_${idx}`;
    const body = extractFunctionBody(fn);

    // Idempotent update: if a runner with this name already exists,
    // update its data fields in-place.
    const existing = this.findNodeByExactName(runnerName);
    if (existing) {
      this.mutations.push({ kind: 'setData', nodeId: existing.id, key: 'division', value: division });
      this.mutations.push({ kind: 'setData', nodeId: existing.id, key: 'source', value: body });
      if (!existing.data) existing.data = {};
      existing.data.division = division;
      existing.data.source = body;
      this.log.push({ message: `clocked('${division}', …) → updated ${runnerName}` });
      return runnerName;
    }
    // Spawn a new clockedRunner. Position: just below the owning
    // LIVECODE card by default; the host stacks them when running
    // multiple clocked() calls.
    const id = this.allocateId('clockedRunner' as ModuleType);
    const origin = this.input.spawnOrigin ?? { x: 60, y: 60 };
    const node: ModuleNode = {
      id,
      type: 'clockedRunner' as ModuleType,
      domain: 'audio',
      position: { x: origin.x, y: origin.y + 80 + (idx - 1) * 200 },
      params: {},
      data: { name: runnerName, division, source: body, ownerNodeId: this.input.ownerNodeId },
    };
    this.mutations.push({ kind: 'spawnNode', node });
    this.workingNodes[id] = { ...node, params: { ...node.params }, data: { ...node.data } };
    this.nameToId.set(runnerName.toLowerCase(), id);
    this.log.push({ message: `clocked('${division}', …) → spawn ${runnerName}` });
    return runnerName;
  }

  private opLog(args: unknown[]): void {
    const message = args.map(formatLogArg).join(' ');
    this.log.push({ message });
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private resolveDef(type: string): DefPorts | undefined {
    return getDefForType(type) ?? getDefForType(type.toLowerCase());
  }

  private allocateId(type: ModuleType): string {
    if (this.input.allocateId) return this.input.allocateId(type);
    return `${String(type)}-${cryptoRandomShort()}`;
  }

  private lookupNode(ref: string): ModuleNode | undefined {
    const id = this.nameToId.get(ref.toLowerCase());
    if (id) return this.workingNodes[id];
    return this.workingNodes[ref];
  }

  private findNodeByExactName(name: string): ModuleNode | undefined {
    const lower = name.toLowerCase();
    for (const n of Object.values(this.workingNodes)) {
      const nm = readName(n);
      if (nm && nm.toLowerCase() === lower) return n;
    }
    return undefined;
  }
}

// ─── Standalone helpers (also used by clocked-runner) ───────────────

/** Extract the BODY of a function as a string. Used by clocked() to
 *  snapshot the user's arrow function into the spawned runner module's
 *  data.source field.
 *
 *  Strategy:
 *    1. fn.toString() returns the source code (V8 + WebKit).
 *    2. For arrow fns "() => { … }" we strip the `() => ` prefix +
 *       enclosing braces. For "() => expr" without braces we wrap
 *       expr in `return expr;` so the runner's wrapper sees a valid
 *       statement.
 *    3. For named functions "function fn() { … }" we strip the
 *       function header + braces.
 *
 *  Fallback (unknown shape): return fn.toString() raw + let the
 *  runner's editor render it as-is.
 */
export function extractFunctionBody(fn: (...args: unknown[]) => unknown): string {
  const src = fn.toString();
  // Arrow function with braces: "(...) => { body }" or "() => { body }"
  const arrowBlock = src.match(/^[^=]*=>\s*\{([\s\S]*)\}\s*$/);
  if (arrowBlock) return arrowBlock[1]!.trim();
  // Arrow function expression: "(...) => expr"
  const arrowExpr = src.match(/^[^=]*=>\s*([\s\S]+)$/);
  if (arrowExpr) return `return ${arrowExpr[1]!.trim()};`;
  // function literal: "function name(...) { body }"
  const fnBlock = src.match(/^function\s*\w*\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/);
  if (fnBlock) return fnBlock[1]!.trim();
  return src;
}

/** Tick-time runner for a single clocked function body. Used by the
 *  clockedRunner module's factory. Takes the user-authored body text
 *  + a per-tick context (the same global proxies the LIVECODE runtime
 *  exposes), compiles it once with new Function, and returns a callable
 *  the factory invokes per tick.
 *
 *  Errors at compile time → returns an error sentinel (the runner's
 *  card surfaces it in its status bar). Errors at call time → captured
 *  + surfaced the same way. */
export type CompiledClockedFn =
  | { ok: true; call: (globals: Record<string, unknown>) => void }
  | { ok: false; error: string };

export function compileClockedBody(body: string, globalNames: string[]): CompiledClockedFn {
  try {
    const fn = new Function(...globalNames, `'use strict';\n${body}`) as
      (...args: unknown[]) => unknown;
    return {
      ok: true,
      call: (globals: Record<string, unknown>) => {
        const vals = globalNames.map((n) => globals[n]);
        try {
          fn.apply(undefined, vals);
        } catch (e) {
          // Per-tick error: rethrow with a tagged prefix so the
          // factory's catch logs it without spamming the console
          // on every tick.
          throw new Error(`runtime: ${(e as Error).message}`);
        }
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function isValidDivision(d: string): d is ClockedDivision {
  return (CLOCKED_DIVISIONS as readonly string[]).includes(d);
}

function formatLogArg(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch { return String(v); }
}

function cryptoRandomShort(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

const RESERVED_KEYWORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum',
  'await', 'true', 'false', 'null', 'undefined',
]);
