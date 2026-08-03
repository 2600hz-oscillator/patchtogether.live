// scripts/e2e-observation-window.test.ts
//
// SOURCE-LEVEL GATE: a shared e2e OBSERVATION WINDOW must accumulate INSIDE THE
// PAGE, never by polling from Playwright.
//
// ── why a source gate and not a runtime one ─────────────────────────────────
//
// The property being protected is ARCHITECTURAL — "how many Playwright↔page
// round trips does one observation window cost?" — and it is NOT recoverable
// from the window's RESULT. A poll loop and an in-page accumulator return the
// same shape; on an idle machine they return the same numbers. The difference
// only materialises under main-thread contention, which is precisely where you
// cannot write a stable assertion. So no runtime gate can see this, and CLAUDE.md
// already names the answer for that situation: "Guard it at the SOURCE level,
// since no runtime gate sees it" (the `controlFamilies` → card-testid grep in
// module-docs-lint.test.ts is the standing precedent).
//
// ── what went wrong, measured ──────────────────────────────────────────────
//
// `readScopePeakOverWindow` was
//     while (Date.now() < deadline) { await page.evaluate(read); await page.waitForTimeout(60) }
// — one CDP round trip per sample, on the SAME main thread as the audio graph,
// the step scheduler and the WebGL cards it measures. From the trace of the run
// that failed (PR #1303, e2e shard 1/10, run 30758889295, `cube poly chord
// (POLYSEQZ → poly)`), BOTH attempts:
//
//     attempt      ONE readScopeSnapshot     ONE waitForTimeout(60)
//     initial           255 ms                    392 ms     → 647 ms > 600 ms
//     retry #1          325 ms                    393 ms     → 718 ms > 600 ms
//
// The "600 ms window" therefore took exactly ONE 42 ms analyser peek, ~250 ms
// after the chord steps were seeded — before the first gated chord could reach
// the audio thread. It reported `Received: 0`, indistinguishable from a genuinely
// silent module. CLAUDE.md, defence #5: "'Frozen' and 'never looked' both print
// `Received: 1` and are indistinguishable from the output. Move the accumulator
// INTO the page."
//
// ── scope of this gate (stated, because an unstated scope reads as full
//    coverage — the cable-stripe-palette lesson) ──────────────────────────────
//
// This gate reads EXACTLY the files in `GUARDED` below: the SHARED e2e helpers
// that expose a max-hold observation window to many specs. It says NOTHING about
// per-spec code, and it is not a ban on `page.waitForTimeout` in general (a
// one-shot settle is fine — `runFor` is exactly that). What it forbids is a
// LOOP that talks to the page once per sample. Add a new shared observation
// helper → add it here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Shared e2e helper files that expose an observation window to many specs. */
const GUARDED = [
  'e2e/tests/_module-coverage-helpers.ts',
  'e2e/tests/_grand-helpers.ts',
] as const;

/** Exported helpers whose whole job is "observe a page-side quantity over a
 *  window". Each MUST drive its accumulator from inside a single
 *  `page.evaluate`. Adding a new one without listing it here is fine for the
 *  loop ban (which is file-wide) but loses the positive check, so keep it
 *  current. */
const OBSERVATION_HELPERS: { file: string; fn: string }[] = [
  { file: 'e2e/tests/_module-coverage-helpers.ts', fn: 'readScopePeakOverWindow' },
  { file: 'e2e/tests/_grand-helpers.ts', fn: 'readMixLevelsOverWindow' },
];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** Strip block + line comments so the prose ABOVE (which quotes the forbidden
 *  loop verbatim, on purpose) can't trip the gate it documents. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Extract a top-level `export async function <name>(…) { … }` body by brace
 *  matching. Returns '' when the function isn't found.
 *
 *  ⚠ The parameter list can itself contain braces (`opts: Options = {}`), so we
 *  first walk the PARENS to their close and only then take the next `{` — the
 *  naive `indexOf('{')` grabs the default-value object and every check below
 *  then reads an empty body and passes vacuously. Found by this gate's own
 *  first run, which is the cheapest kind of negative control there is. */
function functionBody(src: string, name: string): string {
  const sig = new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`);
  const m = sig.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length; // just past the opening '('
  let parens = 1;
  while (i < src.length && parens > 0) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')') parens--;
    i++;
  }
  const open = src.indexOf('{', i);
  if (open === -1) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open, j + 1);
    }
  }
  return '';
}

describe('e2e observation windows accumulate IN THE PAGE', () => {
  it('no shared helper polls the page from Playwright inside a loop', () => {
    const offenders: string[] = [];
    for (const rel of GUARDED) {
      const src = stripComments(read(rel));
      const lines = src.split('\n');
      // Track brace depth of `while (…) {` / `for (…) {` blocks and flag any
      // `page.waitForTimeout(` or `await page.evaluate(` that sits inside one.
      // A loop that costs one round trip PER ITERATION is the whole bug; a
      // one-shot settle or a single evaluate outside a loop is fine.
      let loopDepth = 0;
      const braceStack: boolean[] = []; // true = this brace opened a loop
      lines.forEach((line, i) => {
        const isLoopHead = /\b(while|for)\s*\(/.test(line);
        if (loopDepth > 0 && /\bpage\.(waitForTimeout|evaluate)\s*\(/.test(line)) {
          offenders.push(
            `${rel}:${i + 1}  ${line.trim()}\n` +
              `    → a Playwright→page call INSIDE a loop: one CDP round trip per sample, ` +
              `on the same main thread as the subject. Move the accumulator into ONE ` +
              `page.evaluate (setInterval in the page).`,
          );
        }
        for (const c of line) {
          if (c === '{') braceStack.push(isLoopHead);
          else if (c === '}') {
            if (braceStack.pop()) loopDepth--;
          }
        }
        // A loop head whose brace opened on this line raises the depth for the
        // NEXT lines (the flag pushed above carries it).
        if (isLoopHead && line.includes('{')) loopDepth++;
      });
    }
    expect(
      offenders,
      `Shared e2e observation helpers must not poll the page from Playwright:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every shared observation helper drives its accumulator inside page.evaluate', () => {
    for (const { file, fn } of OBSERVATION_HELPERS) {
      const body = functionBody(stripComments(read(file)), fn);
      expect(body, `${file}: could not find \`export async function ${fn}\``).not.toBe('');
      expect(
        body.includes('page.evaluate'),
        `${file}: ${fn} must observe via a single page.evaluate`,
      ).toBe(true);
      expect(
        body.includes('setInterval'),
        `${file}: ${fn} must accumulate on a setInterval INSIDE the page — that is what ` +
          `survives a main-thread stall (a stalled thread that later runs still reports ` +
          `every value it computed).`,
      ).toBe(true);
    }
  });

  it('readScopePeakOverWindow refuses to report a peak it never sampled', () => {
    // "the instrument never looked" must not be able to print as "the module is
    // silent" — that ambiguity is what cost the shard-1 run two red attempts.
    const body = functionBody(
      stripComments(read('e2e/tests/_module-coverage-helpers.ts')),
      'readScopePeakOverWindow',
    );
    expect(body).toContain('polls === 0');
    expect(body).toContain('throw new Error');
  });
});
