// packages/web/src/lib/ui/media/card-media-lifetime.test.ts
//
// THE SOURCE-LEVEL GATE for node-owned media lifetime — pure-unit, no GL, no
// DOM, no browser.
//
// WHY A SOURCE GREP AND NOT A RUNTIME ASSERT: the defect is a TEARDOWN that
// runs on card unmount. No runtime gate in this repo can see it — the engine
// keeps drawing (measured: the per-node draw counter advanced 130 -> 619
// across the collapse that destroyed playback), pull-eval keeps the node
// evaluated, and every def-reading gate is looking at the wrong side of the
// contract. This is the same reasoning that put the `controlFamilies` ->
// card-testid grep and the `attachExternalSource` grep in the tree: when the
// only observable is in the SOURCE, guard the source.
//
// DENY BY DEFAULT + AUTO-ENROLLING: the subject set is DERIVED from
// DOM_SOURCE_LANE_TYPES (itself held exhaustive by dom-source-modules.test.ts's
// grep gate), so a NEW DOM-source video module is enrolled the moment it
// exists. There is no opt-in list to forget to join and no filename filter —
// the audited-2026-08-02 blind-gate lesson is that a gate which filters its
// own subject quietly redefines what it proves.
//
// WHAT IT FORBIDS, and why each one is a real bug and not a style rule:
//   * `URL.revokeObjectURL` in an unmount path — the loaded file becomes
//     unrecoverable; measured, this is what made re-expanding show the
//     "re-link your file" prompt for a video that had never been unloaded.
//   * `track.stop()` in an unmount path — a capture stream cannot be restarted
//     without a fresh user gesture, so loopback / cameraInput went dark
//     permanently rather than merely pausing.
//   * `attachExternalSource(..., null)` in an unmount path — detaches the
//     engine from an element that still exists and is still playing.
// All three are legitimate on NODE deletion; they belong to
// $lib/ui/media/node-media-registry, which is keyed to graph lifetime and
// swept from Canvas against the live node set.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import '$lib/meta/modules';

import { listModuleDefs } from '$lib/audio/module-registry';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { listMetaModuleDefs } from '$lib/meta/module-registry';
import { conventionalCardName, type CardDefLike } from '$lib/ui/modules-card-map';
import { DOM_SOURCE_LANE_TYPES } from '$lib/ui/workflow/dom-source-modules';

const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** module type id -> card component basename (explicit `def.card` wins, else
 *  the PascalCase convention) — the same resolution buildNodeTypes uses. */
function typeToCardName(): Map<string, string> {
  const defs: CardDefLike[] = [
    ...(listModuleDefs() as unknown as CardDefLike[]),
    ...(listVideoModuleDefs() as unknown as CardDefLike[]),
    ...(listMetaModuleDefs() as unknown as CardDefLike[]),
  ];
  const map = new Map<string, string>();
  for (const def of defs) map.set(def.type, def.card ?? conventionalCardName(def.type));
  return map;
}

/**
 * Strip line + block comments, leaving string and template-literal contents
 * intact.
 *
 * This is load-bearing, not hygiene: the FIRST run of this gate flagged the two
 * cards that had just been FIXED, because their new comment explains what is
 * "deliberately ABSENT here: no `attachExternalSource(id, 'video', null)`" —
 * and the pattern matched the PROSE. A gate that reads comments as code
 * reports the opposite of the truth. (The sibling attachExternalSource grep
 * dodges this only by luck: the comments it walks past happen to omit the
 * parens.) Quote-aware so a url or a regex inside a string is never eaten.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'tpl';
  let mode: Mode = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tpl';
      out += c; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      // keep newlines so line numbers/structure stay roughly aligned
      if (c === '\n') out += c;
      i++; continue;
    }
    // inside a string/template: copy through, honouring escapes
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if (
      (mode === 'single' && c === "'") ||
      (mode === 'double' && c === '"') ||
      (mode === 'tpl' && c === '`')
    ) mode = 'code';
    out += c; i++;
  }
  return out;
}

/**
 * Extract the bodies of every UNMOUNT path in a card: `onDestroy(...)` blocks.
 * Brace-matched from the call site so a nested block cannot truncate the
 * region. Comments are stripped FIRST (see stripComments).
 */
function unmountBodies(raw: string): string[] {
  const src = stripComments(raw);
  const out: string[] = [];
  for (const marker of ['onDestroy(']) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at === -1) break;
      const open = src.indexOf('{', at);
      if (open === -1) break;
      let depth = 0;
      let end = open;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      out.push(src.slice(open, end + 1));
      from = end + 1;
    }
  }
  return out;
}

const FORBIDDEN: { name: string; re: RegExp; why: string }[] = [
  {
    name: 'revokeObjectURL',
    re: /revokeObjectURL\s*\(/,
    why: 'revoking on unmount makes the loaded file unrecoverable; hand the url to nodeMedia.setObjectUrl instead',
  },
  {
    name: 'track.stop()',
    re: /getTracks\s*\(\s*\)|\.stop\s*\(\s*\)/,
    why: 'stopping capture tracks on unmount needs a fresh user gesture to undo; hand the stream to nodeMedia.setStream instead',
  },
  {
    name: "attachExternalSource(…, null)",
    re: /attachExternalSource\s*\([^)]*\bnull\s*\)/,
    why: 'detaching on unmount blanks a source that still exists; the element is node-owned and outlives the card',
  },
];

describe('DOM-source cards must not tear their media down on UNMOUNT', () => {
  const byType = typeToCardName();

  // The subject set is derived, so this cannot silently become empty.
  it('resolves a real card file for every DOM-source module type', () => {
    const files = new Set(readdirSync(CARD_DIR));
    const unresolved: string[] = [];
    for (const type of DOM_SOURCE_LANE_TYPES) {
      const base = byType.get(type);
      if (!base || !files.has(`${base}.svelte`)) unresolved.push(type);
    }
    expect(unresolved, `DOM-source types with no resolvable card: ${unresolved.join(', ')}`)
      .toEqual([]);
    expect(DOM_SOURCE_LANE_TYPES.size).toBeGreaterThan(0);
  });

  it('no DOM-source card revokes urls, stops tracks or detaches in an unmount path', () => {
    const offenders: string[] = [];
    for (const type of [...DOM_SOURCE_LANE_TYPES].sort()) {
      const base = byType.get(type);
      if (!base) continue;
      const src = readFileSync(new URL(`${base}.svelte`, `file://${CARD_DIR}`), 'utf8');
      for (const body of unmountBodies(src)) {
        for (const f of FORBIDDEN) {
          if (f.re.test(body)) offenders.push(`${base} (${type}): ${f.name} — ${f.why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // NEGATIVE CONTROL, permanent leg: the same predicate the gate calls, fed a
  // body that DOES tear down. If `unmountBodies`/FORBIDDEN ever stop matching
  // (a refactor, a renamed hook), this goes red instead of the gate silently
  // passing everything — the failure mode the 2026-08-02 blind-gate audit
  // found in four gates at once.
  it('the predicate actually fires on a teardown body (negative control)', () => {
    const hostile = `
      onDestroy(() => {
        const ve = videoEngine();
        try { ve?.attachExternalSource(id, 'video', null); } catch {}
        if (objectUrl) { URL.revokeObjectURL(objectUrl); }
        for (const t of stream.getTracks()) t.stop();
      });
    `;
    const bodies = unmountBodies(hostile);
    expect(bodies).toHaveLength(1);
    const hits = FORBIDDEN.filter((f) => f.re.test(bodies[0]!)).map((f) => f.name);
    expect(hits.sort()).toEqual(
      ['attachExternalSource(…, null)', 'revokeObjectURL', 'track.stop()'].sort(),
    );
  });

  it('the predicate does NOT fire on a clean unmount body (negative control)', () => {
    const clean = `
      onDestroy(() => {
        stopGateLoop();
        unregisterVideoExport(id);
        mediaLease?.release();
      });
    `;
    const bodies = unmountBodies(clean);
    expect(bodies).toHaveLength(1);
    expect(FORBIDDEN.filter((f) => f.re.test(bodies[0]!))).toEqual([]);
  });

  it('a COMMENT describing the teardown does not trip the gate', () => {
    // The exact shape that produced this gate's first (false) failure.
    const documented = `
      onDestroy(() => {
        // NOTE what is deliberately ABSENT here: no \`attachExternalSource(id,
        // 'video', null)\`, no \`URL.revokeObjectURL\`, no \`track.stop()\`.
        /* block form too: URL.revokeObjectURL(objectUrl); */
        mediaLease?.release();
      });
    `;
    const bodies = unmountBodies(documented);
    expect(bodies).toHaveLength(1);
    expect(FORBIDDEN.filter((f) => f.re.test(bodies[0]!)).map((f) => f.name)).toEqual([]);
  });

  it('stripComments leaves string and template contents intact', () => {
    // A comment stripper that eats these would silently blind the gate.
    expect(stripComments(`const u = 'https://x/y';`)).toContain("'https://x/y'");
    expect(stripComments('const t = `a // b`;')).toContain('`a // b`');
    expect(stripComments(`const s = "/* not a comment */";`)).toContain(
      '"/* not a comment */"',
    );
    expect(stripComments(`code(); // gone`)).not.toContain('gone');
    expect(stripComments(`code(); /* gone */ more();`)).not.toContain('gone');
  });

  it('brace matching survives a nested block inside the unmount body', () => {
    const nested = `
      onDestroy(() => {
        if (a) { for (const x of y) { z(x); } }
        cleanup();
      });
      function later() { URL.revokeObjectURL(other); }
    `;
    const bodies = unmountBodies(nested);
    expect(bodies).toHaveLength(1);
    // The revoke lives OUTSIDE the unmount path and must not be attributed to it.
    expect(FORBIDDEN.filter((f) => f.re.test(bodies[0]!))).toEqual([]);
  });
});
