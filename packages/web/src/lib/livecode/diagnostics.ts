// packages/web/src/lib/livecode/diagnostics.ts
//
// CodeMirror linter for LIVECODE source. Scans the document for
// patch() / unpatch() calls and validates each:
//
//   * Args parse as 'moduleName.portId' strings.
//   * Module exists on the rack.
//   * Ports exist on the module's def.
//   * The two endpoints form a TYPE-COMPATIBLE pair in at least one
//     direction (the runtime's resolveCable handles direction
//     ambiguity; the linter uses the same helper).
//
// Each problem becomes a CodeMirror Diagnostic at the offending
// arg's source position with severity='error' — the @codemirror/lint
// extension underlines it in red.
//
// We DON'T attempt to validate spawn() type names here (the runtime
// throws a clear error if the type isn't registered, and we'd need a
// registry import + force-load which adds noise). Patch validation is
// the high-value catch since it's the most common typo source +
// catching it pre-Run gives the user a much tighter feedback loop.

import type { Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import type { ModuleNode, Edge } from '$lib/graph/types';
import { resolveCable } from './port-types';

export interface LintEnvironment {
  liveNodes: Record<string, ModuleNode | undefined>;
  liveEdges: Record<string, Edge | undefined>;
}

/** Build a linter source bound to the live rack. CodeMirror calls this
 *  on each document change (debounced). Cheap because we limit our
 *  parsing to a regex scan. */
export function makeLinter(envFn: () => LintEnvironment) {
  return (view: EditorView): Diagnostic[] => {
    const env = envFn();
    const doc = view.state.doc.toString();
    return lintDoc(doc, env);
  };
}

/** Pure function — exported separately so unit tests can call it
 *  without spinning up a real EditorView. */
export function lintDoc(doc: string, env: LintEnvironment): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Match `patch('a.b', 'c.d')` / `unpatch(...)` calls and capture each
  // arg's quoted-string body. We tolerate single, double, or backtick
  // quotes; we don't try to parse expressions (only quoted literals).
  // Pattern: WORD ( ARG1 , ARG2 ) — capture each arg's start position
  // so we can emit the diagnostic at the correct text range.
  const re = /\b(patch|unpatch)\s*\(\s*(['"`])([^'"`]*)\2\s*,\s*(['"`])([^'"`]*)\4\s*\)/g;
  for (const m of doc.matchAll(re)) {
    if (m.index === undefined) continue;
    // The first arg starts at: m.index + m[0].indexOf(m[2]) — i.e. the
    // first quote char in the match. We mark the WHOLE call (m.index
    // through m.index + m[0].length) as the diagnostic range so the
    // squiggly is visible even for short identifiers.
    const refA = m[3]!;
    const refB = m[5]!;
    const res = resolveCable(env.liveNodes, refA, refB);
    if (!res.ok) {
      out.push({
        from: m.index,
        to: m.index + m[0].length,
        severity: 'error',
        message: `${m[1]}: ${res.reason}`,
        source: 'livecode',
      });
    }
  }
  return out;
}
