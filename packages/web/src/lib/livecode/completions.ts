// packages/web/src/lib/livecode/completions.ts
//
// CodeMirror autocomplete source. Knows about:
//
//   * Static API symbols   (spawn / patch / unpatch / set / read /
//                          listModules / clocked / every / log /
//                          clock.*)
//   * Spawned module names (dynamic — read from the live patch graph
//                          on each invocation)
//   * Module ports         — when cursor is at the second arg of
//                          patch()/unpatch() AND the first arg is a
//                          resolved port ref, the suggestions are
//                          FILTERED to compatible target ports only.
//
// The "filter by compatibility" piece is the user-requested ergonomic
// win: typing `patch('vco1.sine', '|')` should suggest `scope1.ch1`
// (audio in) but NOT `seq1.gate` (gate in).

import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import type { ModuleNode, Edge, CableType } from '$lib/graph/types';
import {
  getDefForNode,
  isPatchCompatible,
  parsePortRef,
  findModuleByName,
  type DefPorts,
} from './port-types';
import {
  LIVECODE_API,
  CLOCKED_DIVISIONS,
  listApiFunctionNames,
  listNamespaceMembers,
  listModuleProxyFields,
} from './api-surface';

export interface CompletionEnvironment {
  liveNodes: Record<string, ModuleNode | undefined>;
  liveEdges: Record<string, Edge | undefined>;
}

/** Build a completion source bound to the current rack state. The
 *  EditorView's autocomplete extension calls this on every keystroke
 *  (debounced); cheap enough to recompute on each call. */
export function makeCompletionSource(envFn: () => CompletionEnvironment) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const env = envFn();

    // 1) Inside a string argument of patch()/unpatch()? Filter by type.
    const patchArgHint = detectPatchArgContext(ctx, env);
    if (patchArgHint) return patchArgHint;

    // 2) After-dot completion: `name.|` or `clock.|`
    const dotHint = detectDotContext(ctx, env);
    if (dotHint) return dotHint;

    // 3) Generic identifier completion: any top-level name.
    const word = ctx.matchBefore(/[A-Za-z_][\w]*/);
    if (!word) return null;
    if (word.from === word.to && !ctx.explicit) return null;

    const opts: Completion[] = [];
    // Static API fns.
    for (const name of listApiFunctionNames()) {
      const entry = LIVECODE_API.find((e) => e.kind === 'fn' && e.name === name);
      const info = entry && entry.kind === 'fn'
        ? `${entry.signature}\n\n${entry.summary}`
        : undefined;
      opts.push({ label: name, type: 'function', info, boost: 5 });
    }
    // clock namespace already covered by listApiFunctionNames (it's
    // pushed as an identifier); add it explicitly for the namespace tag.
    opts.push({ label: 'clock', type: 'namespace', info: 'Master TIMELORDE clock. clock.start() / clock.stop() / clock.bpm(n)', boost: 4 });

    // Spawned module names (dynamic).
    for (const node of Object.values(env.liveNodes)) {
      if (!node) continue;
      const name = node.data?.name;
      if (typeof name === 'string') {
        opts.push({
          label: name,
          type: 'variable',
          info: `${node.type} module — read fields via .params / .step / .type, or pass as the first arg to set()/read()/patch()`,
          boost: 3,
        });
      }
    }

    return { from: word.from, options: opts, validFor: /^[A-Za-z_][\w]*$/ };
  };
}

/** Returns a completion result for the patch/unpatch arg context, or
 *  null if the cursor isn't in one. */
function detectPatchArgContext(
  ctx: CompletionContext,
  env: CompletionEnvironment,
): CompletionResult | null {
  // We need to know:
  //   * Is the cursor inside a string-literal arg of a patch() or
  //     unpatch() call?
  //   * Which arg? (first vs second)
  //   * If second, what's the first arg?
  // Use a heuristic regex on the recent text since we don't have a
  // proper AST handy. The regex tolerates whitespace + the surrounding
  // single-or-double quotes.
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 120), ctx.pos);
  // Match patterns of the form:
  //   patch('a.b', '
  //   patch('
  //   unpatch('foo.bar', "
  const m = /\b(patch|unpatch)\s*\(\s*(?:(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*,\s*)?(?:'|"|`)([A-Za-z0-9_.]*)$/.exec(before);
  if (!m) return null;
  const firstArg = m[2] ?? m[3] ?? m[4] ?? null; // may be undefined for "first arg" itself
  const partial = m[5] ?? '';
  const isSecondArg = !!firstArg;

  // Compute the slice start for the replacement: cursor minus partial.length
  const from = ctx.pos - partial.length;

  // Build the list of candidate refs.
  const allRefs: { ref: string; portType: CableType; isInput: boolean; ownerName: string; ownerType: string }[] = [];
  for (const node of Object.values(env.liveNodes)) {
    if (!node) continue;
    const def = getDefForNode(node);
    if (!def) continue;
    const ownerName = (node.data?.name as string | undefined) ?? node.id;
    for (const p of def.inputs) {
      allRefs.push({ ref: `${ownerName}.${p.id}`, portType: p.type, isInput: true, ownerName, ownerType: node.type });
    }
    for (const p of def.outputs) {
      allRefs.push({ ref: `${ownerName}.${p.id}`, portType: p.type, isInput: false, ownerName, ownerType: node.type });
    }
  }

  // Filter by partial-match on the ref.
  const partLow = partial.toLowerCase();
  const matches = allRefs.filter((r) => r.ref.toLowerCase().includes(partLow));

  // For the second arg, restrict to type-compatible directions only.
  let filtered = matches;
  if (isSecondArg && firstArg) {
    const parsed = parsePortRef(firstArg);
    if (parsed) {
      const firstNode = findModuleByName(env.liveNodes, parsed.node);
      const firstDef = firstNode ? getDefForNode(firstNode) : undefined;
      if (firstDef) {
        const out = firstDef.outputs.find((p) => p.id === parsed.port);
        const inn = firstDef.inputs.find((p) => p.id === parsed.port);
        if (out) {
          // first is OUTPUT — second must be a compatible INPUT
          filtered = matches.filter((r) => r.isInput && isPatchCompatible(out.type, r.portType));
        } else if (inn) {
          // first is INPUT — second must be a compatible OUTPUT (reverse direction)
          filtered = matches.filter((r) => !r.isInput && isPatchCompatible(r.portType, inn.type));
        }
      }
    }
  }

  const options: Completion[] = filtered.map((r) => ({
    label: r.ref,
    type: r.isInput ? 'property' : 'class',
    detail: `${r.portType}${r.isInput ? ' in' : ' out'}`,
    info: `${r.ownerType} ${r.isInput ? 'input' : 'output'} port (${r.portType})`,
    boost: 5,
  }));

  if (options.length === 0) {
    return { from, options: [{ label: partial || '— no compatible ports —', type: 'text', boost: -10 }], validFor: /^[A-Za-z0-9_.]*$/ };
  }
  return { from, options, validFor: /^[A-Za-z0-9_.]*$/ };
}

/** Returns a completion result for `someName.|` — namespace members,
 *  module proxy fields, or module-port suggestions when used outside a
 *  patch() call. */
function detectDotContext(
  ctx: CompletionContext,
  env: CompletionEnvironment,
): CompletionResult | null {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 80), ctx.pos);
  const m = /([A-Za-z_][\w]*)\.([A-Za-z_]?[\w]*)$/.exec(before);
  if (!m) return null;
  const owner = m[1]!;
  const partial = m[2]!;
  const from = ctx.pos - partial.length;

  // Skip inside patch() / unpatch() string args — handled by patchArg path.
  // Heuristic: if we're inside a string literal, abort.
  const lineUpToCursor = ctx.state.sliceDoc(ctx.state.doc.lineAt(ctx.pos).from, ctx.pos);
  if (/(['"`])[^'"`]*$/.test(lineUpToCursor)) return null;

  // Namespace lookup (clock.*).
  const namespaceMembers = listNamespaceMembers(owner);
  if (namespaceMembers.length > 0) {
    const options: Completion[] = namespaceMembers
      .filter((n) => n.toLowerCase().includes(partial.toLowerCase()))
      .map((n) => ({ label: n, type: 'method', info: `${owner}.${n}()`, boost: 4 }));
    return { from, options, validFor: /^[\w]*$/ };
  }

  // Module proxy: owner is a spawned module name.
  const moduleNode = findModuleByName(env.liveNodes, owner);
  if (moduleNode) {
    const options: Completion[] = [];
    for (const f of listModuleProxyFields()) {
      if (f.toLowerCase().includes(partial.toLowerCase())) {
        options.push({ label: f, type: 'property', info: `${owner}.${f}`, boost: 3 });
      }
    }
    return { from, options, validFor: /^[\w]*$/ };
  }
  return null;
}

/** Convenience: exposed for clocked() arg autocomplete (first arg is the
 *  division literal). Future: hook this into a more nuanced
 *  arg-string-context detector. */
export const CLOCKED_DIVISION_COMPLETIONS: Completion[] = CLOCKED_DIVISIONS.map((d) => ({
  label: `'${d}'`,
  type: 'constant',
  info: `Clock division: ${d}`,
  boost: 4,
}));
