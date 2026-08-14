// packages/web/src/lib/ui/vrt-config-budget.test.ts
//
// THE VRT CONFIG'S KNOBS MUST BE KNOBS PLAYWRIGHT ACTUALLY TURNS.
//
// ─────────────────────────────────────────────────────────────────────────
// THE BUG THIS EXISTS FOR
//
// `e2e/vrt/vrt.config.ts` carried, inside `expect.toHaveScreenshot`:
//
//     timeout: 15_000,
//
// under a 14-line comment explaining that the heavy WebGL cards blow the
// 5000 ms default and that raising it was what stopped `--update-snapshots`
// from wedging the whole darwin baseline regen.
//
// `expect.toHaveScreenshot` has NO `timeout` key. Playwright 1.59 accepts
// exactly: threshold, maxDiffPixels, maxDiffPixelRatio, animations, caret,
// scale, stylePath, pathTemplate (node_modules/playwright/types/test.d.ts).
// The extra key was silently dropped and the real budget stayed 5000 ms —
// so the regen kept wedging on precisely the cards the comment named:
//
//     Timeout: 5000ms
//       Failed to take two consecutive stable screenshots.
//     mandelbulb  4082 / 3954 / 3936 px (ratio 0.02)
//     toybox      5784 / 6604 / 5929 px (ratio 0.02)
//
// A "Timeout: 5000ms" printed by a config that says 15_000 is the tell, and
// it went unnoticed for as long as the setting existed. Worse, the numbers it
// produced were then used as evidence: a card that "cannot settle" under a
// budget a third of the documented one looks exactly like a card that needs a
// mask. This is the CLAUDE.md instrument-validation failure in its purest
// form — the measurement was taken with a knob that was not connected.
//
// ⚠ WHY TYPESCRIPT DID NOT CATCH IT (then): `defineConfig()` gets an object
// literal, so excess-property checking would have rejected `timeout` on sight.
// But at the time the `e2e` workspace had NO `typecheck` script and NO
// tsconfig.json, so `npm run typecheck --workspaces --if-present` (task
// typecheck) skipped it entirely. #1499 closed that hole (e2e/tsconfig.json +
// a typecheck script, guarded by workspace-typecheck-guard.test.ts) — and the
// burn-down promptly found a sibling of this very bug: `use.reducedMotion` at
// the top level of both VRT configs, a knob Playwright 1.59 never read. This
// test stays as the runtime-independent leg: tsc proves the KEYS are real,
// this proves the VALUES/budgets are the ones Playwright actually turns.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT CHECKS
//
//   1. Every key inside `expect.toHaveScreenshot` is one Playwright reads.
//      Derived from the INSTALLED types, not a hand-copied list, so a
//      Playwright upgrade that adds/removes a key updates the guard for free.
//   2. The screenshot settle budget is present at `expect.timeout` — the key
//      that actually bounds the toHaveScreenshot retry loop.
//   3. The tolerance knobs the whole gate rests on are still present.
//
// Pure-unit, file-reading, zero flake, ~0 CI wall-time.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

function repoRoot(): string {
  return resolve(import.meta.dirname, '../../../../..');
}

const PW_TYPES = resolve(repoRoot(), 'node_modules/playwright/types/test.d.ts');

/** Extract the literal body of `expect: { … }` from the VRT config source.
 *  A brace-matcher rather than a regex: the block contains nested objects and
 *  a regex would either stop early or swallow the rest of the file. */
function expectBlock(src: string): string {
  const start = src.search(/^\s{2}expect:\s*\{/m);
  if (start < 0) throw new Error('vrt.config.ts: no top-level `expect: {` block found');
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('vrt.config.ts: unbalanced braces in the `expect` block');
}

/** Same, for a named nested object inside a block. */
function nestedBlock(block: string, key: string): string {
  const start = block.search(new RegExp(`^\\s*${key}:\\s*\\{`, 'm'));
  if (start < 0) throw new Error(`vrt.config.ts: no \`${key}: {\` inside expect`);
  const open = block.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < block.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') {
      depth--;
      if (depth === 0) return block.slice(open + 1, i);
    }
  }
  throw new Error(`vrt.config.ts: unbalanced braces in \`${key}\``);
}

/** Strip comments so a `// timeout: 15_000` in prose is not read as a key.
 *  (The config's own explanatory comments MENTION the dead key by name, which
 *  is the point of them — the guard must not trip on the explanation.) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Top-level `key:` names declared directly in a block (depth 0 only). */
function topLevelKeys(block: string): string[] {
  const code = stripComments(block);
  const out: string[] = [];
  let depth = 0;
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim();
    if (depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(line);
      if (m) out.push(m[1]!);
    }
    for (const ch of rawLine) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  return out;
}

/** The keys Playwright ACTUALLY accepts under `expect.toHaveScreenshot`,
 *  read out of the installed types rather than hand-listed — so a Playwright
 *  bump cannot leave this guard asserting a stale contract. */
function playwrightScreenshotConfigKeys(): string[] {
  const src = readFileSync(PW_TYPES, 'utf8');
  const start = src.indexOf('toHaveScreenshot?: {');
  expect(start, 'playwright types: no `toHaveScreenshot?: {` block').toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  let depth = 0;
  let body = '';
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        body = src.slice(open + 1, i);
        break;
      }
    }
  }
  return [...new Set([...body.matchAll(/^\s{6}(\w+)\??:/gm)].map((m) => m[1]!))];
}

/**
 * EVERY Playwright config, DISCOVERED — not a hand-listed pair.
 *
 * ⚠ This test used to hard-code `e2e/vrt/vrt.config.ts`. That is exactly how
 * the bug it exists to catch survived in a sibling: `vrt-annotated.config.ts`
 * carried the identical `timeout` nested inside `toHaveScreenshot` (silently
 * ignored by Playwright, so the annotated GENERATION run was bounded by the
 * 5000 ms default rather than the 15 s the comment promised) for as long as
 * the guard was pointed one file away from it. A gate that names ONE file
 * cannot speak for the directory — so this walks `e2e/**` and every config it
 * finds is checked, which means a NEW config is covered the day it lands.
 */
function playwrightConfigs(): string[] {
  const root = resolve(repoRoot(), 'e2e');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.config\.ts$/.test(ent.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const CONFIGS = playwrightConfigs();
/** Configs that actually declare screenshot budgets — the subset the knob
 *  assertions apply to. A config with no `expect` block is not a defect. */
const SCREENSHOT_CONFIGS = CONFIGS.filter((p) =>
  /toHaveScreenshot/.test(readFileSync(p, 'utf8')),
);

describe('VRT config: every knob is one Playwright turns', () => {
  it('discovery found the Playwright configs (instrument check)', () => {
    // Negative control on the DISCOVERY: a walk that silently returns nothing
    // would make every parameterized case below vacuous.
    expect(CONFIGS.length, 'found no *.config.ts under e2e/').toBeGreaterThan(2);
    expect(
      CONFIGS.some((p) => p.endsWith('vrt/vrt.config.ts')),
      'the main VRT config must be among the discovered set',
    ).toBe(true);
    expect(
      SCREENSHOT_CONFIGS.length,
      'no config declares toHaveScreenshot — the knob checks would all be vacuous',
    ).toBeGreaterThan(1);
  });

  it('the installed Playwright types expose a toHaveScreenshot key list', () => {
    const keys = playwrightScreenshotConfigKeys();
    // Negative control on the INSTRUMENT: if this parse ever returns nothing
    // (types moved / renamed), the key check below would pass vacuously.
    expect(keys.length, 'parsed 0 keys out of the Playwright types').toBeGreaterThan(3);
    expect(keys).toContain('threshold');
  });

  describe.each(SCREENSHOT_CONFIGS.map((p) => [p.slice(repoRoot().length + 1), p] as const))(
    '%s',
    (rel, path) => {
      const src = readFileSync(path, 'utf8');

      it('expect.toHaveScreenshot contains NO key Playwright ignores', () => {
        const allowed = new Set(playwrightScreenshotConfigKeys());
        const declared = topLevelKeys(nestedBlock(expectBlock(src), 'toHaveScreenshot'));
        const unknown = declared.filter((k) => !allowed.has(k));
        expect(
          unknown,
          `These keys are declared inside \`expect.toHaveScreenshot\` in ${rel} ` +
            'but Playwright does not read them — they are SILENTLY DROPPED, so whatever the ' +
            'comment above them promises is not happening. `timeout` was one of these for as ' +
            'long as it existed: the config said 15_000 and the run used the 5000 ms ' +
            'default, which is why --update-snapshots kept wedging on mandelbulb/toybox. ' +
            `Playwright accepts: ${[...allowed].join(', ')}. ` +
            'A settle budget belongs on `expect.timeout`.',
        ).toEqual([]);
      });

      it('the screenshot settle budget lives on expect.timeout, where it is read', () => {
        const keys = topLevelKeys(expectBlock(src));
        expect(
          keys,
          `\`expect.timeout\` is the only key that bounds ${rel}'s toHaveScreenshot ` +
            'screenshot-until-two-consecutive-captures-agree retry loop. Without it the ' +
            'heavy WebGL cards get Playwright’s 5000 ms default and a slow settle reads as ' +
            '"this card can never be deterministic" — which is how a card ends up masked ' +
            'for a config bug.',
        ).toContain('timeout');
        const m = /^\s*timeout:\s*([\d_]+)/m.exec(stripComments(expectBlock(src)));
        expect(m, `${rel}: expect.timeout must be a numeric literal`).not.toBeNull();
        expect(
          Number(m![1]!.replace(/_/g, '')),
          `${rel}: expect.timeout must exceed Playwright’s 5000 ms default — otherwise ` +
            'setting it changes nothing and the heavy cards are back where they started.',
        ).toBeGreaterThan(5_000);
      });

      it('the tolerance knobs the gate rests on are still declared', () => {
        const declared = topLevelKeys(nestedBlock(expectBlock(src), 'toHaveScreenshot'));
        expect(declared).toContain('threshold');
        expect(declared).toContain('maxDiffPixelRatio');
        expect(declared).toContain('animations');
      });
    },
  );
});
