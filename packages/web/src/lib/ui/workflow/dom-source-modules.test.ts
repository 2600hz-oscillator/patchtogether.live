// packages/web/src/lib/ui/workflow/dom-source-modules.test.ts
//
// The DOM-SOURCE drift GATE — pure-unit, zero-flake, no GL / no DOM.
//
// The owner P0 it pins: under `?shell=1` the lane renders a tile INSTEAD of a
// module's legacy card, and for the minority of video modules whose pixels come
// from a CARD-OWNED `<video>`/`<img>` handed to the engine via
// `attachExternalSource`, that silently killed the SOURCE — camera → OUTPUT (and
// videobox / archivist / … → OUTPUT) was patched-but-black while the engine node
// itself existed. The fix keeps those cards mounted off-screen
// (<HeadlessSourceHost>) or, for cameraInput, keeps the real card in the lane
// (NON_SHELL_LANE_TYPES).
//
// Both fixes are driven off DOM_SOURCE_LANE_TYPES, so the ONE way this can
// regress is a NEW (or renamed) DOM-source module missing from the set. Test 1
// closes that hole MECHANICALLY: it greps every card component for a real
// `attachExternalSource(` call and asserts the derived type set is EXACTLY the
// declared set — a new source module cannot ship dark under the shell.

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

import { DOM_SOURCE_LANE_TYPES, needsHeadlessSourceMount } from './dom-source-modules';
import { NON_SHELL_LANE_TYPES, laneRenderKind, type LaneRenderKind } from './legacy-fallback';

/** The card directory the glob resolver reads (../modules relative to here). */
const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));

/** A REAL call, not a mention in prose: `attachExternalSource(` / `?.(`.
 *  (Comments in these cards say "attachExternalSource" without parens, and the
 *  card-side calls always look like `ve?.attachExternalSource(` /
 *  `engine.attachExternalSource(`.) */
const CALL_RE = /attachExternalSource\s*\(/;

/** card component BASENAME → module type id, exactly the way buildNodeTypes
 *  resolves it (explicit `def.card` wins, else the PascalCase convention). */
function cardNameToType(): Map<string, string> {
  const defs: CardDefLike[] = [
    ...(listModuleDefs() as unknown as CardDefLike[]),
    ...(listVideoModuleDefs() as unknown as CardDefLike[]),
    ...(listMetaModuleDefs() as unknown as CardDefLike[]),
  ];
  const map = new Map<string, string>();
  for (const def of defs) map.set(def.card ?? conventionalCardName(def.type), def.type);
  return map;
}

describe('DOM_SOURCE_LANE_TYPES — the grep gate (a new source module cannot ship dark)', () => {
  it('is EXACTLY the set of module types whose card calls attachExternalSource()', () => {
    const byName = cardNameToType();
    const found = new Set<string>();
    const unmapped: string[] = [];

    for (const file of readdirSync(CARD_DIR)) {
      if (!file.endsWith('Card.svelte')) continue;
      const src = readFileSync(new URL(file, `file://${CARD_DIR}`), 'utf8');
      if (!CALL_RE.test(src)) continue;
      const base = file.replace(/\.svelte$/, '');
      const type = byName.get(base);
      if (!type) {
        unmapped.push(base);
        continue;
      }
      found.add(type);
    }

    // Every card that attaches a DOM source must resolve to a registered def —
    // otherwise the set below can't possibly be complete.
    expect(unmapped, `card(s) calling attachExternalSource resolve to no module def: ${unmapped.join(', ')}`)
      .toEqual([]);

    // Sanity: the grep found SOMETHING (a refactor that renames the engine hook
    // must fail loudly here rather than silently emptying the set).
    expect(found.size).toBeGreaterThan(0);

    expect([...found].sort()).toEqual([...DOM_SOURCE_LANE_TYPES].sort());
  });

  it('lists the known capture/media-source modules (readable failure if one is dropped)', () => {
    for (const t of ['cameraInput', 'videobox', 'videovarispeed', 'archivist', 'peertube', 'tvLibrarian', 'loopback', 'frametable', 'videocube']) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is a DOM-source module`).toBe(true);
    }
    // Boundary: a pure-GPU generator is NOT one (acidwarp renders from a shader
    // only — it needs no card, which is why acidwarp → OUTPUT survived the bug).
    for (const t of ['acidwarp', 'lines', 'backdraft', 'ruttetra', 'videoOut']) {
      expect(DOM_SOURCE_LANE_TYPES.has(t), `${t} is NOT a DOM-source module`).toBe(false);
    }
  });
});

describe('needsHeadlessSourceMount — the pure headless-mount decision', () => {
  const KINDS: LaneRenderKind[] = ['legacy', 'shell', 'placeholder', 'stub'];

  it('mounts ONLY when the shell swapped the card away (shell | placeholder)', () => {
    for (const kind of KINDS) {
      const want = kind === 'shell' || kind === 'placeholder';
      expect(needsHeadlessSourceMount({ kind, type: 'videobox' }), `videobox @ ${kind}`).toBe(want);
    }
  });

  it('never mounts a non-DOM-source module, whatever the lane renders', () => {
    for (const kind of KINDS) {
      expect(needsHeadlessSourceMount({ kind, type: 'acidwarp' })).toBe(false);
      expect(needsHeadlessSourceMount({ kind, type: 'tidyvco' })).toBe(false);
    }
  });

  it("never DOUBLE-mounts: 'legacy' (card in the lane) and 'stub' (card in the dock rail) are excluded", () => {
    // Two live <video> elements for one node would each getUserMedia, and
    // whichever unmounted first would detach the survivor's source.
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: 'cameraInput' })).toBe(false);
    expect(needsHeadlessSourceMount({ kind: 'stub', type: 'videobox' })).toBe(false);
  });

  it('is a strict NO-OP under ?shell=legacy (that path can only produce legacy/stub)', () => {
    for (const type of DOM_SOURCE_LANE_TYPES) {
      const kind = laneRenderKind({
        shellFaces: false,
        userDocked: false,
        type,
        hasCard: true,
        migrated: false,
      });
      expect(kind).toBe('legacy');
      expect(needsHeadlessSourceMount({ kind, type })).toBe(false);
    }
  });
});

describe('cameraInput — the CAPTURE-SOURCE carve-out (source + device picker live on the card)', () => {
  it('keeps its REAL card in the lane under the faceplate default', () => {
    expect(NON_SHELL_LANE_TYPES.has('cameraInput')).toBe(true);
    expect(
      laneRenderKind({
        shellFaces: true,
        userDocked: false,
        type: 'cameraInput',
        // isShellSwappable() returns false for a NON_SHELL type — Canvas passes
        // that through as hasCard.
        hasCard: false,
        migrated: false,
      }),
    ).toBe('legacy');
  });

  it('is therefore never headless-hosted (no double getUserMedia)', () => {
    expect(needsHeadlessSourceMount({ kind: 'legacy', type: 'cameraInput' })).toBe(false);
  });

  it('leaves every OTHER DOM-source module on the uniform tile (the shell look is preserved)', () => {
    for (const t of DOM_SOURCE_LANE_TYPES) {
      if (t === 'cameraInput') continue;
      expect(NON_SHELL_LANE_TYPES.has(t), `${t} still swaps to a tile`).toBe(false);
      expect(needsHeadlessSourceMount({ kind: 'placeholder', type: t })).toBe(true);
    }
  });
});
