// scripts/canvas-mount-only-hooks.test.ts
//
// GATE: Canvas.svelte's `globalThis.__*` e2e hook installers run from `onMount`,
// and they publish GETTERS, not snapshots.
//
// The hazard this exists for
// --------------------------
// `onMount(fn)` is `$effect(() => untrack(fn))`. Two of Canvas's hook installers
// were `$effect` blocks that could only ever run once — they read nothing
// reactive and installed no cleanup, because the globals deliberately outlive
// the component. `onMount` says that; `$effect` said "re-runs and tears down",
// which was false in both halves.
//
// Converting them makes ONE thing newly breakable: under `$effect`, a bare
// reactive read added at the body's top level would have re-installed the hook
// on every change; under `onMount` it LATCHES the mount-time value and every
// e2e that reads the hook silently gets a stale object. Nothing at runtime can
// tell the difference — the latched value is a perfectly ordinary value — so the
// guard has to be at the source level. The convention that keeps it safe is
// already in the file: expose `() => engine`, never `engine`.
//
// ⚠ `svelte-check` does NOT cover this, measured rather than assumed. Rewriting
// Canvas's `__engine = () => engine` to `__engine = engine` and re-running
// `task typecheck` left the run at 0 errors / 46 warnings, unchanged, with no
// diagnostic naming Canvas.svelte: `state_referenced_locally` does not fire
// inside an `onMount` callback. So the compiler is not a substitute for this
// file, and a green typecheck says nothing about the invariant below.
//
// WHY THIS IS SCOPED TO Canvas.svelte, and why that is not a silent filter
// -----------------------------------------------------------------------
// The same predicate run over every tracked `packages/**/*.svelte` reports 43
// offending mounts (measured 2026-08-13, 331 files, 95 with an `onMount`) — and
// essentially all of them are the ORDINARY, CORRECT Svelte 5 pattern: reading a
// `bind:this` ref (`canvasEl`, `previewEl`, `editorEl`) that is assigned before
// `onMount` fires. Reading reactive state in `onMount` is not a bug in general.
// It is a bug for a HOOK INSTALLER specifically, whose whole contract is that
// the published value stays live for the rest of the session. So the subject is
// "onMount blocks that assign `globalThis.__*`", derived from the artifact by
// what the block DOES — never a line number and never a typed list of names.
//
// What this gate is structurally unable to see is documented on the analysis
// module (`scripts/mount-only-analysis.ts`) and re-asserted below: it cannot see
// reactivity arriving through an imported `.svelte.ts` store's PROPERTY, it says
// nothing about `$effect` blocks, and indirection defeats it. It is a floor.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeComponent, type MountBlock } from './mount-only-analysis';

const CANVAS = resolve(import.meta.dirname, '../packages/web/src/lib/ui/Canvas.svelte');

function hookInstallerMounts(text: string, label: string): MountBlock[] {
  return analyzeComponent(text, label).mounts.filter((m) => m.installsGlobals.length > 0);
}

describe('Canvas test-hook installers are mount-only', () => {
  it('anchors to the artifact: Canvas.svelte exists and still installs __* hooks from onMount', () => {
    // Anti-vacuity. If Canvas is renamed, or the installers move out of
    // `onMount` (back to `$effect`, or into an extracted controller — stage 7
    // of #1513), the subject becomes empty and every assertion below passes
    // while measuring nothing. That must be RED, not green.
    expect(existsSync(CANVAS), `${CANVAS} not found — update this gate's anchor`).toBe(true);
    const installers = hookInstallerMounts(readFileSync(CANVAS, 'utf8'), 'Canvas.svelte');
    expect(
      installers.map((m) => `Canvas.svelte:${m.line} installs ${m.installsGlobals.join(' ')}`),
      'no onMount block in Canvas.svelte assigns globalThis.__* — this gate is measuring nothing',
    ).not.toEqual([]);
  });

  it('publishes getters, not snapshots: no installer reads component state at its own top level', () => {
    const text = readFileSync(CANVAS, 'utf8');
    const offenders = hookInstallerMounts(text, 'Canvas.svelte')
      .filter((m) => m.reactiveReads.length > 0)
      .map(
        (m) =>
          `Canvas.svelte:${m.line} — onMount installing ${m.installsGlobals.slice(0, 3).join(', ')}… reads ` +
          `rune-declared [${m.reactiveReads.join(', ')}] at its OWN top level. onMount untracks, so that ` +
          `value is latched at mount and never refreshed. Publish a getter instead: () => ${m.reactiveReads[0]}.`,
      );
    expect(offenders).toEqual([]);
  });

  it('the analyser can see the runes it is checking against', () => {
    // A gate whose "reactive names" set came back empty would report zero
    // offenders for any input at all. Prove the left-hand side of the
    // intersection is populated from the real file before trusting the right.
    const { runes } = analyzeComponent(readFileSync(CANVAS, 'utf8'), 'Canvas.svelte');
    expect(runes.map((r) => r.name), 'no rune declarations found in Canvas.svelte').not.toEqual([]);
    // Anchored to rune NAMES, never to how many of each there are: if the
    // recogniser silently stopped matching one form, `$derived.by` (which
    // reaches the analyser as a PropertyAccessExpression callee, unlike bare
    // `$state`) is the one most likely to go first.
    const kinds = new Set(runes.map((r) => r.rune));
    for (const kind of ['$state', '$derived', '$derived.by', '$props']) {
      expect(kinds.has(kind), `analyser recognised no ${kind} declaration in Canvas.svelte`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Permanent negative + positive control, on the SAME predicate the gate calls.
// These are not illustrations: they are the reason a green run above means
// anything. The negative leg proves the predicate can go RED; the positive leg
// proves it is not simply flagging every read (which would make it useless in
// the other direction, and would have flagged the real file).
// ---------------------------------------------------------------------------

const FIXTURE_SAFE = `<script lang="ts">
  import { onMount } from 'svelte';
  let engine = $state(null);
  let flowApi = $state(null);
  const plain = makeThing();
  onMount(() => {
    (globalThis as any).__engine = () => engine;
    (globalThis as any).__flow = { getInternalNode: (id: string) => flowApi?.getInternalNode(id) };
    (globalThis as any).__plain = plain;
  });
</script>
<div>markup mentioning engine and flowApi</div>`;

const FIXTURE_LATCHED = `<script lang="ts">
  import { onMount } from 'svelte';
  let engine = $state(null);
  let flowApi = $state(null);
  const plain = makeThing();
  onMount(() => {
    (globalThis as any).__engine = engine;
    (globalThis as any).__flow = { getInternalNode: (id: string) => flowApi?.getInternalNode(id) };
    (globalThis as any).__plain = plain;
  });
</script>
<div>markup mentioning engine and flowApi</div>`;

describe('control: the predicate moves when the thing it measures moves', () => {
  it('POSITIVE — a getter-publishing installer is clean (and markup mentions do not count)', () => {
    const [m] = hookInstallerMounts(FIXTURE_SAFE, 'fixture-safe.svelte');
    expect(m, 'fixture has one onMount installer').toBeDefined();
    expect(m!.installsGlobals).toEqual(['__engine', '__flow', '__plain']);
    expect(m!.reactiveReads).toEqual([]);
  });

  it('NEGATIVE — assigning the reactive value itself is caught, and named', () => {
    const [m] = hookInstallerMounts(FIXTURE_LATCHED, 'fixture-latched.svelte');
    expect(m, 'fixture has one onMount installer').toBeDefined();
    expect(m!.reactiveReads).toEqual(['engine']);
    // The DIFFERENCE between the two fixtures is one character-level change —
    // `engine` vs `() => engine` — and nothing else. If the analyser were
    // insensitive to closure depth (the one dimension under test) both fixtures
    // would read the same, and this pair would still both "pass" a weaker
    // assertion. Assert they differ.
    const safe = hookInstallerMounts(FIXTURE_SAFE, 'fixture-safe.svelte')[0]!;
    expect(m!.reactiveReads).not.toEqual(safe.reactiveReads);
  });

  it('SCOPE — states what it still cannot see', () => {
    // Reactivity through an imported store PROPERTY is invisible here: the
    // analyser only knows about rune declarations in the file it is given.
    const viaImportedStore = `<script lang="ts">
  import { onMount } from 'svelte';
  import { dockStore } from '$lib/ui/dock-store.svelte';
  onMount(() => {
    (globalThis as any).__tombstones = dockStore.tombstoneCount;
  });
</script>`;
    const [m] = hookInstallerMounts(viaImportedStore, 'fixture-store.svelte');
    expect(m!.installsGlobals).toEqual(['__tombstones']);
    expect(
      m!.reactiveReads,
      'documented blind spot: a reactive PROPERTY of an imported .svelte.ts store is not detected',
    ).toEqual([]);
  });
});
