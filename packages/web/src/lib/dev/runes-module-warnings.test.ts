// The `.svelte.ts` half of the `--fail-on-warnings` gate (#1602, closing the
// blind spot #1549's gate shipped with).
//
// svelte-check compiles only `.svelte` files with the Svelte compiler — a
// `.svelte.ts` runes module is plain TypeScript to it, so a compiler warning
// there (measured: `state_referenced_locally` in lib/audio/shared-clock.svelte.ts)
// reached the vite-plugin-svelte build log and NO gate. A gate that reads only
// half the warning stream proves nothing about the other half, so this test IS
// the other half: it compiles every `*.svelte.ts` / `*.svelte.js` under src/
// with the real Svelte compiler (`compileModule`) and fails on ANY warning,
// deny by default.
//
// TS is stripped with node's `stripTypeScriptTypes` in `strip` mode, which
// blank-pads types — LINE AND COLUMN NUMBERS ARE PRESERVED EXACTLY and comments
// survive, so `// svelte-ignore <code> — <why>` works here the same as in a
// `.svelte` file, offenders are reported at their true source position (the
// vite pipeline reports post-esbuild lines: 110 for a warning that lives at
// 231), and every suppression is auditable by svelte-ignore-audit, which
// already walks these files. A module the instrument CANNOT compile (strip or
// parse failure) is reported as an offender, never skipped — fail closed.
//
// What this gate is structurally unable to see:
//   • `.svelte` files — that half belongs to `svelte-check --fail-on-warnings`
//     (packages/web/package.json `typecheck`).
//   • cross-module analysis: each module is compiled in isolation, exactly as
//     vite-plugin-svelte compiles it.
//   • runtime behavior of the suppressed sites — a `svelte-ignore` here is an
//     exemption record, and svelte-ignore-audit enforces that it says why.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { compileModule } from 'svelte/compiler';

const SRC_ROOT = resolve(import.meta.dirname, '../..');

interface ModuleProblem {
  /** src-relative path, with line:column in TRUE source coordinates (1-based). */
  where: string;
  code: string;
  message: string;
}

/**
 * THE predicate — the tree scan and every control below call this same
 * function. Returns [] only when the module compiles with zero warnings.
 */
function runesModuleProblems(file: string, source: string): ModuleProblem[] {
  let js: string;
  try {
    js = file.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
  } catch (e) {
    return [{ where: file, code: 'ts_strip_failed', message: String(e) }];
  }
  try {
    const { warnings } = compileModule(js, { filename: file, generate: false });
    return warnings.map((w) => ({
      where: `${file}:${w.start?.line}:${w.start?.column} (1-based source line:col)`,
      code: w.code,
      message: w.message.split('\n')[0],
    }));
  } catch (e) {
    return [{ where: file, code: 'compile_failed', message: String(e) }];
  }
}

/** Every runes module the vite pipeline would hand to `compileModule`. */
function runesModules(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
      runesModules(p, acc);
    } else if (entry.name.endsWith('.svelte.ts') || entry.name.endsWith('.svelte.js')) {
      acc.push(p);
    }
  }
  return acc;
}

describe('runes modules compile with zero Svelte compiler warnings', () => {
  it('every *.svelte.{ts,js} under src/ is warning-free (or carries a reasoned svelte-ignore)', () => {
    const offenders = runesModules(SRC_ROOT).flatMap((abs) =>
      runesModuleProblems(abs.slice(SRC_ROOT.length + 1), readFileSync(abs, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan is not vacuous — it reaches the file that motivated the gate', () => {
    // Without this, deleting the walk would green the assertion above by finding
    // nothing. shared-clock.svelte.ts is the module whose warning no gate could
    // see (#1602); it has been in the tree since #45.
    const files = runesModules(SRC_ROOT);
    expect(files.length, 'the walk found runes modules').toBeGreaterThan(0);
    expect(
      files.some((f) => f.endsWith('lib/audio/shared-clock.svelte.ts')),
      'the walk reaches lib/audio/shared-clock.svelte.ts',
    ).toBe(true);
  });
});

describe('CONTROLS on the same predicate the tree scan calls', () => {
  // A TS-flavoured module with the exact warning class that motivated the gate:
  // a $state variable captured by value at init. The annotations make the strip
  // path load-bearing — an instrument that mangled TS would misreport the site.
  const warnLine3 = [
    'let count = $state<number>(0);',
    'const t: string = `x`;',
    'const initial: number = count;',
    'export function get(): number { return initial + t.length; }',
  ].join('\n');

  it('POSITIVE CONTROL: the instrument sees state_referenced_locally in TS, at the true line', () => {
    const problems = runesModuleProblems('fixture.svelte.ts', warnLine3);
    expect(problems.map((p) => p.code)).toEqual(['state_referenced_locally']);
    // Line 3, 1-based, in the ORIGINAL TS — strip mode preserves positions.
    expect(problems[0].where).toContain('fixture.svelte.ts:3:');
  });

  it('NEGATIVE CONTROL: a reasoned `// svelte-ignore` suppresses exactly that warning', () => {
    const suppressed =
      warnLine3.replace(
        'const initial',
        '// svelte-ignore state_referenced_locally — control fixture: deliberate init-only capture.\nconst initial',
      );
    expect(runesModuleProblems('fixture.svelte.ts', suppressed)).toEqual([]);
  });

  it('FAIL-CLOSED: a module the instrument cannot compile is an offender, not a skip', () => {
    const problems = runesModuleProblems('broken.svelte.ts', 'const x: = ;');
    expect(problems.length).toBeGreaterThan(0);
    expect(['ts_strip_failed', 'compile_failed']).toContain(problems[0].code);
  });

  it('FAIL-CLOSED: TS needing real transforms (enum) reddens rather than silently passing', () => {
    // `strip` mode refuses enums/namespaces. If a runes module ever grows one,
    // this gate must say so loudly instead of skipping the file.
    const problems = runesModuleProblems('enum.svelte.ts', 'enum E { A }\nexport const e = E.A;');
    expect(problems.map((p) => p.code)).toEqual(['ts_strip_failed']);
  });
});
