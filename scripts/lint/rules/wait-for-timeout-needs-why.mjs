/**
 * scripts/lint/rules/wait-for-timeout-needs-why.mjs — the deny-by-default half
 * of the `waitForTimeout` ratchet (issue #1523). The design, and what the
 * ratchet structurally cannot see, live in scripts/lint/wait-ledger.mjs; this
 * file is the walk.
 *
 * A NAMED rule, not a staged one: it is deliberately absent from STAGED_RULES
 * in scripts/lint/lint-policy.mjs, so a finding BLOCKS `task lint` — which is
 * in the required `ci` umbrella's failing test as `$LINT`.
 *
 * ⚠ It matches on the AST, not with a regex over the text. This repo quotes the
 * forbidden construct on purpose in prose that documents it (see the header of
 * scripts/e2e-observation-window.test.ts, which reproduces the exact poll loop
 * it bans). A grep-shaped gate reports every one of those; a call expression is
 * a call expression.
 */
import path from 'node:path';
import {
  ROOT,
  MARKER,
  MIN_WHY,
  MATCHED,
  COLLECTED,
  keyFor,
  readLedger,
  hasJustification,
} from '../wait-ledger.mjs';

const LEDGER = readLedger();

/** Playwright block-callback forms whose first argument titles the block. */
const TITLED = new Set([
  'test',
  'it',
  'describe',
  'step',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
]);

/** `test('x', …)` / `test.step('x', …)` / `test.describe.serial('x', …)` → 'x'. */
function titleOf(node) {
  if (node.type !== 'CallExpression') return null;
  let base = node.callee;
  while (base.type === 'MemberExpression') base = base.object;
  const rootName = base.type === 'Identifier' ? base.name : null;
  const leaf =
    node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier'
      ? node.callee.property.name
      : rootName;
  if (!TITLED.has(rootName) && !TITLED.has(leaf)) return null;
  const first = node.arguments[0];
  if (first && first.type === 'Literal' && typeof first.value === 'string') return first.value;
  if (first && first.type === 'TemplateLiteral') {
    return first.quasis.map((q) => q.value.cooked).join('${}');
  }
  return leaf ?? rootName ?? null;
}

/**
 * The nearest enclosing test title, else the nearest named function, else the
 * module. NEAREST-ONLY on purpose: keying on the whole describe→test chain
 * would rewrite every key under a `describe` when its title is reworded, and a
 * ledger whose diff churns for cosmetic reasons stops being reviewable.
 */
function scopeOf(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    const title = titleOf(node);
    if (title) return title;
    if (node.type === 'FunctionDeclaration' && node.id) return node.id.name;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') return node.id.name;
    if (
      (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') &&
      node.key.type === 'Identifier'
    ) {
      return node.key.name;
    }
  }
  return '<module>';
}

/**
 * Comment text on the call's own line, plus the unbroken run of comment lines
 * directly above it.
 *
 * Line-based rather than `sourceCode.getCommentsBefore`, because the natural
 * place to write the annotation is immediately above an `await` inside a block,
 * and ESLint's comment ATTACHMENT there depends on what the preceding sibling
 * statement was — a leading comment after a blank line, or before the first
 * statement of a block, attaches somewhere an author would not predict. A run
 * of `//` lines directly above, or a trailing comment on the same line, is what
 * people actually write, so that is what this reads.
 */
function annotationReader(sourceCode) {
  /** line number → concatenated comment text on that line */
  const byLine = new Map();
  for (const c of sourceCode.getAllComments()) {
    for (let line = c.loc.start.line; line <= c.loc.end.line; line++) {
      byLine.set(line, `${byLine.get(line) ?? ''} ${c.value}`);
    }
  }
  return (node) => {
    const callLine = node.loc.start.line;
    const parts = [];
    if (byLine.has(callLine)) parts.push(byLine.get(callLine));
    for (let line = callLine - 1; byLine.has(line); line--) parts.unshift(byLine.get(line));
    return parts.join(' ');
  };
}

/** @type {import('eslint').Rule.RuleModule} */
export const waitForTimeoutNeedsWhy = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A wall-clock wait under e2e/ must name the product-side interval it mirrors; a readiness wait must count frames or assert a predicate instead.',
    },
    schema: [],
    messages: {
      unjustified:
        'Un-annotated `waitForTimeout({{arg}})` (#1523). A wall-clock budget is a DIFFERENT number of frames on every renderer — measured 7.9 fps under E2E_SWIFTSHADER=1 against ~60 fps locally — so this is a per-machine assertion, not one assertion.\n' +
        '  · waiting for RENDER/PAINT → `waitFrames(page, n)` from e2e/_helpers/frames.ts (rAF counted inside the page).\n' +
        '  · waiting for STATE/DOM    → an auto-retrying `await expect(locator)…`, or `expect.poll` on the real subject.\n' +
        '  · a real PRODUCT-SIDE interval (a debounce the app defines, a decay tail, MIDI pacing) → keep the wait and say so ON the call site:\n' +
        '        // {{marker}} <which interval this mirrors, and where the product defines it>   (at least {{min}} characters)\n' +
        '  Not in e2e/waitfortimeout-ledger.generated.txt, so this site is NEW. That ledger records only what predates the rule and `task lint:waits:accept` refuses to grow it.\n' +
        '  key: {{key}}',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const file = path
      .relative(ROOT, context.filename ?? context.getFilename())
      .split(path.sep)
      .join('/');
    const annotationNear = annotationReader(sourceCode);
    /** ordinal counters, keyed by `${scope} ${arg}` within this file */
    const seen = new Map();

    return {
      'CallExpression > MemberExpression.callee'(member) {
        if (member.property.type !== 'Identifier') return;
        if (member.property.name !== 'waitForTimeout') return;
        const call = member.parent;
        const arg = call.arguments[0] ? sourceCode.getText(call.arguments[0]) : '';
        const ancestors = sourceCode.getAncestors
          ? sourceCode.getAncestors(call)
          : context.getAncestors();
        const scope = scopeOf(ancestors);
        const bucket = `${scope} ${arg}`;
        const ordinal = (seen.get(bucket) ?? 0) + 1;
        seen.set(bucket, ordinal);

        // The annotated form is the END STATE, not an exemption: it is what a
        // legitimately time-based wait looks like once someone has said which
        // product-side interval it mirrors. It never enters the ledger.
        if (hasJustification(annotationNear(call))) return;

        const key = keyFor({ file, scope, arg, ordinal });
        COLLECTED.add(key);
        if (LEDGER.has(key)) {
          MATCHED.add(key);
          return;
        }
        context.report({
          node: call,
          messageId: 'unjustified',
          data: { arg, marker: MARKER, min: String(MIN_WHY), key },
        });
      },
    };
  },
};

/** The plugin object eslint.config.mjs registers under the `local` namespace. */
export const localPlugin = {
  rules: { 'wait-for-timeout-needs-why': waitForTimeoutNeedsWhy },
};
