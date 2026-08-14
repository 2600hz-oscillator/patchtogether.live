// The source-level half of the `--fail-on-warnings` gate (#1549).
//
// svelte-check now fails on any compiler warning, so `svelte-ignore` is the only
// escape hatch left. This pins the two properties that make an escape hatch
// trustworthy — it HONOURS every code it names, and it SAYS WHY — with an
// unconditional assertion over the real tree plus permanent controls in both
// directions on the same predicate the tree scan calls.
//
// The premise is verified against the real compiler in the last describe block
// rather than asserted from memory: the space-separated form genuinely does drop
// codes, which is how 8 warnings were live under comments that named them.
//
// Pure fs + string work plus three tiny svelte.compile calls. ~1 s.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import {
  auditIgnoreSites,
  describeProblem,
  findIgnoreSites,
  parseIgnoreBody,
  MIN_REASON_CHARS,
  type IgnoreSite,
} from './svelte-ignore-audit';

const SRC_ROOT = resolve(import.meta.dirname, '../..');

/** Every file the Svelte compiler reads. `.svelte.ts` runes modules included —
 *  `state_referenced_locally` fires there too, and `// svelte-ignore` works there. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
      sourceFiles(p, acc);
    } else if (entry.name.endsWith('.svelte') || entry.name.endsWith('.svelte.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

function allSites(): IgnoreSite[] {
  return sourceFiles(SRC_ROOT).flatMap((abs) =>
    findIgnoreSites(abs.slice(SRC_ROOT.length + 1), readFileSync(abs, 'utf8')),
  );
}

describe('svelte-ignore comments are honest exemption records', () => {
  it('every svelte-ignore honours all its codes and carries a reason', () => {
    const problems = auditIgnoreSites(allSites()).map(describeProblem);
    expect(problems).toEqual([]);
  });

  it('the scan is not vacuous — it reaches real files and real comments', () => {
    // Without this, deleting the walk (or pointing it at an empty dir) would make
    // the assertion above pass by finding nothing. Both numbers have wide slack;
    // neither is a pinned population.
    const files = sourceFiles(SRC_ROOT);
    expect(files.length, 'the walk found svelte sources').toBeGreaterThan(0);
    expect(
      allSites().length,
      'the walk found svelte-ignore comments to audit',
    ).toBeGreaterThan(0);
    expect(
      files.some((f) => f.endsWith('ToyboxCard.svelte')),
      'the walk descends into lib/ui/modules',
    ).toBe(true);
  });
});

describe('CONTROLS on the same predicate the tree scan calls', () => {
  const good =
    '<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions ' +
    '— a portaled backdrop; Escape closes it from the keyboard. -->';

  it('POSITIVE CONTROL: a well-formed comment is clean', () => {
    const sites = findIgnoreSites('x.svelte', good);
    expect(sites).toHaveLength(1);
    expect(sites[0].codes).toEqual([
      'a11y_click_events_have_key_events',
      'a11y_no_static_element_interactions',
    ]);
    expect(sites[0].droppedCodes).toEqual([]);
    expect(auditIgnoreSites(sites)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the space-separated form is reported as dropped codes', () => {
    // THE regression this gate exists for.
    const sites = findIgnoreSites('x.svelte', good.replace(', a11y_no', ' a11y_no'));
    expect(sites[0].codes).toEqual(['a11y_click_events_have_key_events']);
    expect(sites[0].droppedCodes).toEqual(['a11y_no_static_element_interactions']);
    expect(auditIgnoreSites(sites).map((p) => p.kind)).toContain('dropped-codes');
  });

  it('NEGATIVE CONTROL: a reasonless suppression is reported', () => {
    const sites = findIgnoreSites('x.svelte', '<!-- svelte-ignore a11y_autofocus -->');
    expect(sites[0].reason).toBe('');
    expect(auditIgnoreSites(sites).map((p) => p.kind)).toEqual(['missing-reason']);
  });

  it('NEGATIVE CONTROL: a too-short reason does not buy its way past the floor', () => {
    const sites = findIgnoreSites('x.svelte', '<!-- svelte-ignore a11y_autofocus — wontfix -->');
    expect(sites[0].reason.length).toBeLessThan(MIN_REASON_CHARS);
    expect(auditIgnoreSites(sites).map((p) => p.kind)).toEqual(['missing-reason']);
  });

  it('script-block `// svelte-ignore` is audited too, reason and all', () => {
    const src = '<script>\n  // svelte-ignore state_referenced_locally — seed only; re-read below.\n  let a = b;\n</script>';
    const sites = findIgnoreSites('x.svelte', src);
    expect(sites[0].codes).toEqual(['state_referenced_locally']);
    expect(sites[0].line).toBe(2);
    expect(auditIgnoreSites(sites)).toEqual([]);
  });

  it('a `//` inside a string is not mistaken for a comment', () => {
    // The parser anchors on the `svelte-ignore` token and only then looks left for
    // a comment opener, so no URL can manufacture or hide a site.
    expect(findIgnoreSites('x.svelte', `const u = 'https://svelte-ignore fake';`)).toEqual([]);
    expect(findIgnoreSites('x.svelte', `const u = 'https://x.dev'; // svelte-ignore a11y_autofocus — real one here, please. `)).toHaveLength(1);
  });

  it('an em-dash reason is not swallowed into the code list', () => {
    expect(parseIgnoreBody('a11y_autofocus — because.').codes).toEqual(['a11y_autofocus']);
    expect(parseIgnoreBody('a11y_autofocus — because.').reason).toBe('because.');
  });
});

describe('THE PREMISE, checked against the real compiler (not from memory)', () => {
  // If Svelte ever starts honouring the space-separated form, the `dropped-codes`
  // rule becomes noise and this block says so loudly instead of leaving the gate
  // enforcing folklore.
  const body = '<span onclick={() => {}}>x</span>';
  const codes = (ignore: string) =>
    compile(`${ignore}\n${body}`, { generate: 'client', runes: true, filename: 'Probe.svelte' })
      .warnings.map((w) => w.code)
      .sort();

  it('with no ignore, the span raises both a11y warnings', () => {
    expect(codes('')).toEqual([
      'a11y_click_events_have_key_events',
      'a11y_no_static_element_interactions',
    ]);
  });

  it('SPACE-separated: the second code is silently discarded', () => {
    expect(
      codes(
        '<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->',
      ),
    ).toEqual(['a11y_no_static_element_interactions']);
  });

  it('COMMA-separated: both codes are honoured', () => {
    expect(
      codes(
        '<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->',
      ),
    ).toEqual([]);
  });
});
