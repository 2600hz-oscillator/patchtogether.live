// packages/web/src/lib/livecode/migrate.ts
//
// One-way migration of legacy LIVECODE DSL text into the new JS-syntax
// runtime. The old custom DSL had its own grammar (assign / patch /
// member access), now replaced by JS. Existing rack files have
// `node.data.text` strings in the DSL — we can't autorun them; the user
// has to port manually. We wrap the legacy text in a banner comment +
// give them a starter JS scaffold so they're not staring at a blank
// editor.
//
// Detection: a heuristic — the old DSL never wrote `function`, `const`,
// `let`, `=>`, `(`, `;`, `{` outside of strings, so if NONE of those
// tokens appear the text is almost certainly legacy.

const LEGACY_BANNER =
  '/* ──────────────────────────────────────────────────────────────────\n' +
  ' * Legacy DSL script — NOT RUN by the new JS runtime.\n' +
  ' * Port to JS using spawn() / patch() / set() — see Help → LIVECODE.\n' +
  ' * The old text is preserved below for reference only.\n' +
  ' * ────────────────────────────────────────────────────────────────── */\n';

const JS_MARKERS = /\bfunction\b|\bconst\b|\blet\b|=>|;|\{|\bspawn\(|\bpatch\(|\bset\(|\bclocked\(|\bread\(/;

/** True if the text is recognised as legacy DSL (i.e. NOT modern JS). */
export function looksLikeLegacy(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Pure-comment text already migrated — don't double-wrap.
  if (trimmed.startsWith('/*') && /Legacy DSL/.test(trimmed.slice(0, 200))) return false;
  return !JS_MARKERS.test(trimmed);
}

/** Convert legacy DSL text into a JS-comment-wrapped scaffold. The
 *  user sees the original text preserved (so they can port it) plus a
 *  fresh "// your new script here" line at the top to start writing. */
export function migrateLegacyText(legacy: string): string {
  const lines = legacy.split('\n').map((l) => ` * ${l}`);
  return `${LEGACY_BANNER}${lines.join('\n')}\n */\n\n// Your new JS script:\n`;
}
