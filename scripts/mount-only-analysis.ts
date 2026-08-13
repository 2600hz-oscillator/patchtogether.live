// scripts/mount-only-analysis.ts
//
// "Does this `onMount` latch a reactive value?" — a SOURCE-level analysis,
// because no runtime gate can see the difference.
//
// WHY THIS EXISTS
// ---------------
// `onMount(fn)` is `$effect(() => untrack(fn))`. The `untrack` is the whole
// point and the whole hazard: a reactive value read at the callback's OWN top
// level is captured ONCE, at mount, and the callback never runs again. Under
// `$effect` the same line re-runs on every change. So converting an effect to
// `onMount` is sound only while every reactive read happens INSIDE a closure the
// callback installs — read at call time, not at mount time. That distinction is
// invisible at runtime: the latched value is a perfectly ordinary value. This is
// exactly the "guard it at the SOURCE level, since no runtime gate sees it" case
// in CLAUDE.md.
//
// The concrete subject is Canvas.svelte's `globalThis.__*` e2e hook installers,
// which publish getters (`() => engine`) precisely so the value stays live.
//
// WHAT IT MEASURES
// ----------------
// Per component: the names declared with a rune (`$state`, `$state.raw`,
// `$derived`, `$derived.by`, `$props`) in the instance script, and, for each
// `onMount(…)`, the identifiers read at the callback's OWN top level —
// deliberately NOT descending into any nested function, because that is the safe
// case being distinguished. The intersection is the finding.
//
// WHAT IT IS STRUCTURALLY UNABLE TO SEE — state the gate's scope inside the gate
// -----------------------------------------------------------------------------
//   * Reactivity that is not a rune declaration in THIS file. `someStore.value`
//     where `someStore` is an imported `.svelte.ts` class instance IS a signal
//     read, and this analysis cannot tell a reactive import from an inert one.
//     (Reading the imported BINDING is never a signal read — it is a `const`.)
//   * `$effect` blocks. It says nothing about them; effects are supposed to
//     track, and Canvas's remaining 44 effects are legitimate external-system
//     bridges.
//   * Indirection. `const f = () => flowApi; f();` at the top level reads
//     `flowApi` inside an arrow, so it is not counted. This is a FLOOR on the
//     hazard, not a ceiling.
//   * Shadowing. A local `const engine = …` inside the callback that happens to
//     share a name with a rune would be reported as a reactive read.
//
// A caller must not read a green run here as "nothing reactive can leak in".

import ts from 'typescript';
import { svelteScriptSpans } from './attest-code-basis';

/** A rune-declared name and the rune that declared it. */
export type RuneDecl = { name: string; rune: string; line: number };

/** One `onMount(…)` callback in a component. */
export type MountBlock = {
  /** 1-based line of the `onMount` call in the ORIGINAL file. */
  line: number;
  /** Identifiers read at the callback's own top level, source order, deduped. */
  topLevelReads: string[];
  /** `topLevelReads` ∩ rune-declared names — the finding. */
  reactiveReads: string[];
  /**
   * `globalThis.__x` / `window.__x` property names assigned ANYWHERE inside the
   * callback (nested closures included). Non-empty ⇒ this is a hook installer.
   */
  installsGlobals: string[];
};

export type ComponentAnalysis = { runes: RuneDecl[]; mounts: MountBlock[] };

const RUNE_INITIALIZERS = ['$state', '$state.raw', '$derived', '$derived.by', '$props'];

function calleeText(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${calleeText(expr.expression)}.${expr.name.text}`;
  return '';
}

/** Names bound by a declaration name node — plain identifier or binding pattern. */
function boundNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) boundNames(el.name, out);
  }
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * Is this identifier a VALUE READ rather than a name in a non-read position?
 *
 * Excluded: the `b` of `a.b`, the key of `{ b: … }`, any declaration name, a
 * label, an import/export specifier, and anything in a type position.
 */
function isValueRead(id: ts.Identifier): boolean {
  const parent = id.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.objectAssignmentInitializer !== id) {
    // `{ makeEnvelope }` IS a read of `makeEnvelope` — keep it.
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  if (ts.isParameter(parent) && parent.name === id) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === id) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === id) return false;
  if (ts.isPropertySignature(parent) || ts.isTypeReferenceNode(parent)) return false;
  if (ts.isQualifiedName(parent)) return false;
  return true;
}

/** `(globalThis as any).__foo = …` / `window.__foo = …` → `__foo`. */
function globalHookAssignmentName(node: ts.Node): string | null {
  if (!ts.isBinaryExpression(node)) return null;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;
  const lhs = node.left;
  if (!ts.isPropertyAccessExpression(lhs)) return null;
  if (!lhs.name.text.startsWith('__')) return null;
  let obj: ts.Expression = lhs.expression;
  while (ts.isParenthesizedExpression(obj) || ts.isAsExpression(obj)) obj = obj.expression;
  const objName = ts.isIdentifier(obj) ? obj.text : '';
  if (objName !== 'globalThis' && objName !== 'window') return null;
  return lhs.name.text;
}

/**
 * Analyse one `.svelte` file's instance script(s).
 *
 * `text` is the WHOLE file; reported lines are 1-based lines of the original
 * file, so a failure message points at something you can open.
 */
export function analyzeComponent(text: string, fileLabel: string): ComponentAnalysis {
  const runes: RuneDecl[] = [];
  const mounts: MountBlock[] = [];

  for (const { openEnd, bodyEnd } of svelteScriptSpans(text)) {
    const body = text.slice(openEnd, bodyEnd);
    const sf = ts.createSourceFile(
      `${fileLabel}.script.ts`,
      body,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      ts.ScriptKind.TS,
    );
    const lineOf = (pos: number): number => text.slice(0, openEnd + pos).split('\n').length;

    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
        const callee = calleeText(node.initializer.expression);
        if (RUNE_INITIALIZERS.includes(callee)) {
          const names: string[] = [];
          boundNames(node.name, names);
          for (const n of names) runes.push({ name: n, rune: callee, line: lineOf(node.getStart(sf)) });
        }
      }

      if (ts.isCallExpression(node) && calleeText(node.expression) === 'onMount') {
        const cb = node.arguments[0];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const reads: string[] = [];
          const seenRead = new Set<string>();
          // Stop at every nested function: those run later, so a read there is
          // a call-time read and is SAFE — that is the distinction being made.
          const walkTop = (n: ts.Node): void => {
            if (n !== cb.body && isFunctionLike(n)) return;
            if (ts.isIdentifier(n) && isValueRead(n) && !seenRead.has(n.text)) {
              seenRead.add(n.text);
              reads.push(n.text);
            }
            n.forEachChild(walkTop);
          };
          walkTop(cb.body);

          // Separate FULL walk (nested closures included) for hook installs.
          const globals: string[] = [];
          const seenGlobal = new Set<string>();
          const walkAll = (n: ts.Node): void => {
            const g = globalHookAssignmentName(n);
            if (g && !seenGlobal.has(g)) {
              seenGlobal.add(g);
              globals.push(g);
            }
            n.forEachChild(walkAll);
          };
          walkAll(cb.body);

          mounts.push({
            line: lineOf(node.getStart(sf)),
            topLevelReads: reads,
            reactiveReads: [],
            installsGlobals: globals,
          });
        }
      }

      node.forEachChild(visit);
    };
    visit(sf);
  }

  const runeNames = new Set(runes.map((r) => r.name));
  for (const m of mounts) m.reactiveReads = m.topLevelReads.filter((n) => runeNames.has(n));

  return { runes, mounts };
}
