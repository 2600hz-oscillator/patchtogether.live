// packages/web/src/routes/canvas-routes-audio-gate.test.ts
//
// EVERY ROUTE THAT MOUNTS THE CANVAS MOUNTS THE AUDIO GATE.
//
// ── THE DEFECT (#1826) ─────────────────────────────────────────────────────
//
// `AudioGate.svelte` renders "Click anywhere to enable audio" whenever the
// AudioContext is not running. It was mounted in exactly ONE route —
// `/r/[id]`. `/rack`, the DEFAULT route and the one most people land on, had
// zero references to it.
//
// `ensureEngine()` constructs the AudioContext, awaits `resume()`, and only
// THEN reaches `new VideoEngine(...)` — so with no gesture there is no engine at
// all. `/rack` therefore booted nothing, painted every video surface black, made
// no sound, and said nothing about why. It was reported as "video output does
// not work", and disproving that cost a scoped investigation.
//
// ── WHY THIS IS A DERIVED GATE AND NOT A TWO-ENTRY CHECKLIST ───────────────
//
// The obvious fix is "mount it on /rack too", and the obvious guard is "assert
// both routes have it". Both are one route-addition away from being wrong
// again, and the failure is SILENT: a third canvas route would ship with the
// identical bug and every check would stay green.
//
// So the subject is DERIVED: the set of routes that render `Canvas.svelte`, read
// off the tree at test time. Membership is a property of the route's own source,
// so a route added tomorrow is in scope the moment it imports Canvas — nobody
// has to remember to add it here. No count is asserted anywhere; the assertions
// are `offenders === []` over whatever the derivation returns.
//
// The derivation is kept SOUND by `IMPORTERS ARE ROUTES` below: if Canvas is
// ever imported from `$lib` (a wrapper component that a route mounts instead),
// walking `src/routes/**` would silently stop seeing the real canvas mounts. That
// case reddens here with an instruction, rather than quietly narrowing the gate.
//
// ── WHAT IS ASSERTED PER ROUTE, AND WHY THREE THINGS AND NOT ONE ───────────
//
//   1. it imports `$lib/ui/AudioGate.svelte`
//   2. it RENDERS `<AudioGate …/>` in markup — an unused import is not a mount
//   3. it passes `audioGate` INTO `<Canvas …/>`
//
// (3) is the leg that is easy to miss and impossible to see from the UI at a
// glance. The store is bidirectional: Canvas registers `ensureEngine` as the
// gate's booter and binds the live AudioContext to it, and only then does the
// overlay reflect reality. A route that renders <AudioGate> WITHOUT passing the
// store to Canvas gets an overlay that is permanently visible and does nothing
// when clicked — a strictly worse bug than #1826, and one that "the overlay
// renders" would happily certify.
//
// ── ⚠ WHAT THIS GATE STRUCTURALLY CANNOT SEE ──────────────────────────────
//
//   * WHETHER THE OVERLAY WORKS. It reads source text. That the overlay is up
//     on a cold `/rack`, that no engine exists behind it, that it does NOT eat
//     the click it is asking for, and that a real gesture clears it and boots an
//     engine are all asserted in `e2e/tests/audio-gate-cold-rack.spec.ts`,
//     against a real browser with no prior gesture.
//   * ROUTES THAT MOUNT THE APP SOME OTHER WAY. The derivation is "renders
//     Canvas.svelte". `/present` paints into a bare <canvas> the opener draws
//     into — no engine, no Y.Doc, no autoplay policy to explain — and is
//     correctly out of scope. If a future route boots an engine without
//     rendering Canvas, this gate will not know.
//   * CONDITIONAL MOUNTS. `{#if something}<AudioGate/>{/if}` reads as a mount
//     here. Source text cannot evaluate the condition.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const WEB_SRC = resolve(import.meta.dirname, '..');
const ROUTES = resolve(WEB_SRC, 'routes');

/** The component whose presence DEFINES "this route mounts the app". */
const CANVAS_SPECIFIER = '$lib/ui/Canvas.svelte';
const GATE_SPECIFIER = '$lib/ui/AudioGate.svelte';

/** Every `.svelte` file under a directory, recursively. Layouts included: a
 *  route can mount the canvas from `+layout.svelte` just as well as from
 *  `+page.svelte`, and a derivation that only looked at pages would be blind to
 *  exactly the refactor most likely to move it. */
function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...svelteFiles(p));
    else if (ent.name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

/** Every `.svelte`/`.ts` file under `packages/web/src`. Used to prove the
 *  route-scoped derivation is not missing a Canvas mount hidden in `$lib`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(svelte|ts)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const rel = (p: string): string => relative(WEB_SRC, p);

/** Source with `//` line comments and `/* *\/` blocks removed.
 *
 *  ⚠ Comments are stripped BEFORE any of the checks below run, because this
 *  gate greps text and cannot otherwise tell a mount from a sentence describing
 *  one — a route whose only `<AudioGate` is inside a comment explaining that it
 *  deliberately has none would pass. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Does this file IMPORT `spec`? (Default or named — the form does not matter,
 *  only that the module is pulled in.) */
function imports(src: string, spec: string): boolean {
  return new RegExp(`from\\s+['"]${spec.replace(/[$/.]/g, '\\$&')}['"]`).test(src);
}

/** Does this file RENDER `<Tag …>` in markup? */
function renders(src: string, tag: string): boolean {
  return new RegExp(`<${tag}[\\s/>]`).test(src);
}

/** Is `prop` passed to `<Tag …>`? Matches both the shorthand `{audioGate}` and
 *  the explicit `audioGate={…}` spellings. Scans the whole `<Tag … >` opening
 *  tag, which can span many lines. */
function passesProp(src: string, tag: string, prop: string): boolean {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'gs');
  for (const m of src.matchAll(re)) {
    const open = m[0]!;
    if (new RegExp(`\\{\\s*${prop}\\s*\\}|\\b${prop}\\s*=`).test(open)) return true;
  }
  return false;
}

/** THE PREDICATE. Everything a canvas-mounting route owes the audio gate, as a
 *  list of what is missing — empty means compliant.
 *
 *  A single exported function so the permanent negative control below calls the
 *  SAME code the real assertion calls. A control that re-implements the check is
 *  a control of a different check. */
function gateWiringFaults(src: string): string[] {
  const s = stripComments(src);
  const faults: string[] = [];
  if (!imports(s, GATE_SPECIFIER)) faults.push(`does not import ${GATE_SPECIFIER}`);
  if (!renders(s, 'AudioGate')) faults.push('imports AudioGate but never renders <AudioGate …/>');
  if (!passesProp(s, 'Canvas', 'audioGate')) {
    faults.push(
      'does not pass `audioGate` to <Canvas …/> — the overlay would render but never ' +
        'receive a booter or the live AudioContext, so it could never dismiss itself',
    );
  }
  return faults;
}

const ROUTE_FILES = svelteFiles(ROUTES);
/** THE DERIVED SET: every route file that renders the canvas. */
const CANVAS_ROUTES = ROUTE_FILES.filter((p) => {
  const s = stripComments(readFileSync(p, 'utf8'));
  return imports(s, CANVAS_SPECIFIER) && renders(s, 'Canvas');
});

describe('every route that mounts Canvas also mounts the AudioGate (#1826)', () => {
  it('INSTRUMENT: the walk found route files, and some of them mount the canvas', () => {
    // A glob that matches nothing passes every downstream assertion silently.
    // Both legs are needed: "found .svelte files" proves the walk works, and
    // "found canvas routes" proves the FILTER still selects something — a
    // renamed Canvas specifier would leave the first true and the second empty,
    // which is precisely the shape that makes a gate green and blind.
    expect(ROUTE_FILES.length, `no .svelte files under ${rel(ROUTES)}`).toBeGreaterThan(0);
    expect(
      CANVAS_ROUTES.map(rel),
      `no route imports ${CANVAS_SPECIFIER} and renders <Canvas>. Either the app no ` +
        'longer has a canvas route (in which case delete this gate) or the specifier ' +
        'moved and this derivation is now selecting nothing — every assertion below ' +
        'would pass vacuously.',
    ).not.toEqual([]);
  });

  it('IMPORTERS ARE ROUTES — nothing outside src/routes/ renders the canvas', () => {
    // ANCHORS THE DERIVATION. The gate walks `src/routes/**`; that is only a
    // sound way to enumerate canvas mounts while Canvas is mounted BY routes. If
    // someone wraps it in a `$lib` component, every route would stop importing
    // Canvas directly, `CANVAS_ROUTES` would empty out, and the gate would go
    // green while covering nothing.
    const outside = sourceFiles(WEB_SRC)
      .filter((p) => !p.endsWith('/ui/Canvas.svelte'))
      .filter((p) => !p.startsWith(ROUTES + '/'))
      .filter((p) => !/\.test\.ts$/.test(p))
      .filter((p) => imports(stripComments(readFileSync(p, 'utf8')), CANVAS_SPECIFIER))
      .map(rel);
    expect(
      outside,
      'these files outside src/routes/ import Canvas.svelte. If one of them RENDERS it, ' +
        'the route-scoped derivation above no longer sees every canvas mount and this ' +
        'gate has quietly stopped covering the thing it names. Widen the derivation to ' +
        'follow the wrapper (or, if the import is type-only, exclude it here with a reason).',
    ).toEqual([]);
  });

  it('each canvas route imports, renders AND wires the gate', () => {
    const offenders = CANVAS_ROUTES.map((p) => ({
      route: rel(p),
      faults: gateWiringFaults(readFileSync(p, 'utf8')),
    })).filter((r) => r.faults.length > 0);

    expect(
      offenders,
      'A route that mounts Canvas boots NO engine until a user gesture runs ensureEngine ' +
        '— video paints black, audio is silent — so it owes the user the overlay that says ' +
        'so. This is #1826: /rack shipped without it for as long as the check was "does ' +
        '/r/[id] have it".',
    ).toEqual([]);
  });

  it('PERMANENT NEGATIVE CONTROL: the predicate rejects each way of getting it wrong', () => {
    // Calls the SAME `gateWiringFaults` the assertion above calls, over fixtures
    // this test builds — so a refactor that neuters the predicate reddens here
    // even if every real route happens to be compliant.
    const COMPLIANT = `
      <script lang="ts">
        import Canvas from '$lib/ui/Canvas.svelte';
        import AudioGate from '$lib/ui/AudioGate.svelte';
        import { createAudioGate } from '$lib/audio/audio-gate.svelte';
        const audioGate = createAudioGate();
      </script>
      <Canvas {audioGate} rackspaceId="x" />
      <AudioGate gate={audioGate} />
    `;
    expect(gateWiringFaults(COMPLIANT), 'the predicate rejects a CORRECT route').toEqual([]);

    // 1. The #1826 shape itself: canvas, no gate anywhere.
    const NO_GATE = `
      <script lang="ts">
        import Canvas from '$lib/ui/Canvas.svelte';
      </script>
      <Canvas rackspaceId="x" />
    `;
    expect(gateWiringFaults(NO_GATE).length, 'a route with NO gate must be flagged').toBe(3);

    // 2. Imported but never rendered — the shape a half-finished fix leaves.
    const IMPORTED_NOT_RENDERED = `
      <script lang="ts">
        import Canvas from '$lib/ui/Canvas.svelte';
        import AudioGate from '$lib/ui/AudioGate.svelte';
        import { createAudioGate } from '$lib/audio/audio-gate.svelte';
        const audioGate = createAudioGate();
      </script>
      <Canvas {audioGate} rackspaceId="x" />
    `;
    expect(
      gateWiringFaults(IMPORTED_NOT_RENDERED),
      'an AudioGate that is imported but never rendered must be flagged',
    ).toEqual(['imports AudioGate but never renders <AudioGate …/>']);

    // 3. Rendered but not wired into Canvas — an overlay that can never dismiss
    //    itself, and the failure mode a "does the overlay render?" check misses.
    const RENDERED_NOT_WIRED = `
      <script lang="ts">
        import Canvas from '$lib/ui/Canvas.svelte';
        import AudioGate from '$lib/ui/AudioGate.svelte';
        import { createAudioGate } from '$lib/audio/audio-gate.svelte';
        const audioGate = createAudioGate();
      </script>
      <Canvas rackspaceId="x" />
      <AudioGate gate={audioGate} />
    `;
    expect(
      gateWiringFaults(RENDERED_NOT_WIRED).length,
      'an AudioGate not wired into <Canvas> must be flagged',
    ).toBe(1);

    // 4. COMMENTS ARE NOT CODE. A route whose only mention of the gate is prose
    //    explaining its absence must fail exactly like NO_GATE — otherwise this
    //    file's own header would be enough to green a broken route.
    const ONLY_IN_COMMENTS = `
      <script lang="ts">
        import Canvas from '$lib/ui/Canvas.svelte';
        // we deliberately do not import AudioGate from '$lib/ui/AudioGate.svelte'
        /* and we never render <AudioGate gate={audioGate} /> here either */
      </script>
      <Canvas rackspaceId="x" />
    `;
    expect(
      gateWiringFaults(ONLY_IN_COMMENTS).length,
      'a route that only MENTIONS the gate in comments must be flagged like one with none',
    ).toBe(3);
  });
});
