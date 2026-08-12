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
import { STRICT_FACES } from './strict-faces';

/** The card directory the glob resolver reads (../modules relative to here). */
const CARD_DIR = fileURLToPath(new URL('../modules/', import.meta.url));
/** Where module DEFS live — the ARTIFACT this gate anchors to (see §3). */
const AUDIO_DEF_DIR = fileURLToPath(new URL('../../audio/modules/', import.meta.url));
const VIDEO_DEF_DIR = fileURLToPath(new URL('../../video/modules/', import.meta.url));

/**
 * ⚠ TWO FILTERS USED TO SIT IN FRONT OF THIS GATE, AND EACH ONE QUIETLY
 * REDEFINED ITS SUBJECT. Removed 2026-08-10 after wavesculpt shipped a solid
 * black `video_out` through both of them.
 *
 *   1. ONE SEAM NAME. The pattern was `attachExternalSource\s*\(` and nothing
 *      else, so the set was "cards that attach a DOM element" while the set it
 *      is USED as is "modules whose source dies when the card unmounts". Those
 *      differ by a whole second mechanism: `install<X>FrameDrawer(`, which cube
 *      and wavesculpt both use to publish a card-rendered canvas. Ten modules
 *      matched the pattern; two did not and were invisible.
 *   2. ONE FILENAME SHAPE, ONE DIRECTORY. It read `*Card.svelte` from a single
 *      non-recursive `readdirSync`. cube's face work then moved its installer
 *      OUT of `CubeCard.svelte` into `cube/CubeVizSurface.svelte` — a
 *      subdirectory, not named `*Card` — at which point the grep found ZERO
 *      calls for cube and said nothing, because "no call" and "not scanned"
 *      are the same observation to a filename filter.
 *
 * So: DENY BY DEFAULT over **any** seam that hands a mounted component's
 * pixels to the engine, across **every** `.svelte` under `lib/ui/modules/**`.
 * A new seam spelling is added HERE, next to the others, or the module it
 * belongs to goes unaccounted and red.
 */
const CARD_SOURCE_SEAMS: readonly { id: string; re: RegExp }[] = [
  // A card-owned `<video>`/`<img>` handed to the video engine.
  { id: 'attachExternalSource', re: /attachExternalSource\s*\(/ },
  // A card-rendered canvas published to its own module's frame registry. The
  // symbol NAMES ITS MODULE (`installCubeFrameDrawer` → `cube`), which is what
  // lets a non-`*Card` component be attributed without a filename convention.
  { id: 'installFrameDrawer', re: /\binstall([A-Z][A-Za-z0-9]*)FrameDrawer\s*\(/ },
];

/** Any seam at all — the deny-by-default predicate. */
function hasCardSource(src: string): boolean {
  return CARD_SOURCE_SEAMS.some((s) => s.re.test(src));
}

/** Every `.svelte` under lib/ui/modules, RECURSIVELY (see filter 2 above). */
function allModuleComponents(): { rel: string; base: string; src: string }[] {
  const out: { rel: string; base: string; src: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        walk(`${dir}${ent.name}/`, `${prefix}${ent.name}/`);
        continue;
      }
      if (!ent.name.endsWith('.svelte')) continue;
      out.push({
        rel: `${prefix}${ent.name}`,
        base: ent.name.replace(/\.svelte$/, ''),
        src: readFileSync(`${dir}${ent.name}`, 'utf8'),
      });
    }
  };
  walk(CARD_DIR, '');
  return out;
}

/** `installWavesculptFrameDrawer` → `wavesculpt`. The seam symbol is the only
 *  attribution that survives a component being renamed or moved. */
function typeFromDrawerSymbol(pascal: string): string {
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Module types whose FACE mounts the renderer itself, so the card never needs
 * to be kept alive off-screen — the `cube` shape (`CubeVizSurface` is mounted
 * by BOTH `CubeCard` and the hero panel, with an `ownsVideoOut` flag deciding
 * which mount installs the drawer).
 *
 * ⚠ AN ENTRY IS A CLAIM THAT IS CHECKED, not a way out: the named component
 * must really contain an install call, and the module must really be faced.
 * Empty today — cube's face is on another branch. When it lands, cube goes
 * HERE rather than into DOM_SOURCE_LANE_TYPES, because a headless card would
 * then be a SECOND renderer for one node.
 */
const FACE_MOUNTS_SOURCE: Readonly<Record<string, { component: string; why: string }>> = {
  // cube (#1452, merged 2026-08-10) — and it is the reason this branch of the
  // gate exists at all. cube had the identical card-installs-the-drawer shape
  // wavesculpt did, and was hours from shipping the identical black output.
  // Its face work fixed it by accident of good architecture: the volume
  // renderer moved OUT of CubeCard.svelte into cube/CubeVizSurface.svelte,
  // which owns the install/uninstall pair itself (gated on `ownsVideoOut` so
  // two live mounts cannot race), and BOTH the card and the hero panel mount
  // that component. So whichever surface is live, video_out has a real frame.
  //
  // ⚠ THIS DECLARATION IS LOAD-BEARING, not paperwork. CubeCard.svelte now
  // contains ZERO install calls, so the card-shaped half of this gate finds
  // nothing to attribute and would have said nothing about cube either way.
  // The artifact anchor (which reads the DEFS, not the cards) is what caught
  // it — and it caught it on the very merge that faced the module, which is
  // the behaviour the anchor was written for.
  cube: {
    component: 'CubeVizSurface',
    why:
      'the face mounts the renderer itself — cube/CubeVizSurface.svelte installs and ' +
      'uninstalls the frame drawer, and is mounted by BOTH CubeCard and the hero panel, ' +
      'so video_out never falls through to the black-fill branch under ?shell=1',
  },
};

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

/**
 * The frame-drawer registries the module DEFS actually export, as
 * `type → symbol`. This is the AUTHORITY for which `install…FrameDrawer` names
 * are real seams.
 *
 * ⚠ WITHOUT IT THE PATTERN INVENTS MODULES. `WavesculptCard.svelte` wraps its
 * real call in a LOCAL helper called `installBridgeFrameDrawer()`, which
 * matches the shape perfectly and derived a module type `bridge` that has never
 * existed. Worse, the helper is declared one line ABOVE the real call, so a
 * first-match-only scan attributed the file to `bridge` and reported the REAL
 * owner, wavesculpt, as having no installer at all — a false negative and a
 * false positive from one regex.
 */
function declaredDrawerTypes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of [AUDIO_DEF_DIR, VIDEO_DEF_DIR]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
      const src = readFileSync(`${dir}${f}`, 'utf8');
      for (const m of src.matchAll(/export function install([A-Z][A-Za-z0-9]*)FrameDrawer\s*\(/g)) {
        out.set(typeFromDrawerSymbol(m[1]!), `install${m[1]!}FrameDrawer`);
      }
    }
  }
  return out;
}

/** Every module type with a CARD-OWNED SOURCE, by seam, over every component. */
function cardSourceTypes(): { types: Set<string>; unmapped: string[]; bySeam: Map<string, string[]> } {
  const byName = cardNameToType();
  const declared = declaredDrawerTypes();
  const types = new Set<string>();
  const unmapped: string[] = [];
  const bySeam = new Map<string, string[]>(CARD_SOURCE_SEAMS.map((s) => [s.id, []]));

  for (const { rel, base, src } of allModuleComponents()) {
    // (a) the SELF-NAMING seam: the symbol says which module it belongs to, so
    // the component's filename and directory are irrelevant. ⚠ matchAll, not
    // exec — one file can hold several, and the first is not always the real
    // one (see `declaredDrawerTypes`).
    for (const m of src.matchAll(/\binstall([A-Z][A-Za-z0-9]*)FrameDrawer\s*\(/g)) {
      const t = typeFromDrawerSymbol(m[1]!);
      // Only a symbol a DEF exports is a seam; anything else is a local helper.
      if (!declared.has(t)) continue;
      types.add(t);
      bySeam.get('installFrameDrawer')!.push(`${rel} → ${t}`);
    }
    // (b) the ANONYMOUS seam: `attachExternalSource` names no module, so it can
    // only be attributed by the card-name convention. A NON-card component
    // using it is therefore unattributable and must fail loudly rather than be
    // skipped — that silence is exactly how the cube case hid.
    if (/attachExternalSource\s*\(/.test(src)) {
      const type = byName.get(base);
      if (!type) {
        unmapped.push(rel);
      } else {
        types.add(type);
        bySeam.get('attachExternalSource')!.push(`${rel} → ${type}`);
      }
    }
  }
  return { types, unmapped, bySeam };
}

describe('DOM_SOURCE_LANE_TYPES — the grep gate (a new source module cannot ship dark)', () => {
  it('every component that OWNS a module source is attributable to a module', () => {
    const { unmapped } = cardSourceTypes();
    expect(
      unmapped,
      `component(s) call attachExternalSource but resolve to no module def: ${unmapped.join(', ')}. ` +
        'That seam names no module, so it can only be attributed by the *Card.svelte convention — ' +
        'either name the file conventionally or publish through an install<Module>FrameDrawer seam, ' +
        'which is self-naming.',
    ).toEqual([]);
  });

  it('finds BOTH seams — a rename that empties one cannot pass as "no source modules"', () => {
    // The vacuity tripwire, per seam rather than in total. The old version
    // asserted only `found.size > 0`, which one healthy seam satisfies on
    // behalf of a dead one.
    const { bySeam } = cardSourceTypes();
    for (const seam of CARD_SOURCE_SEAMS) {
      expect(
        bySeam.get(seam.id)!.length,
        `the '${seam.id}' seam matched NOTHING. Either every user of it was removed (then delete ` +
          'the pattern from CARD_SOURCE_SEAMS) or it was renamed (then update the pattern) — a ' +
          'silently dead pattern is a gate that has stopped watching a whole mechanism.',
      ).toBeGreaterThan(0);
    }
  });

  it('EVERY FACED module with a card-owned source is ACCOUNTED FOR — deny by default', () => {
    // ⚠ SCOPE, STATED IN THE GATE: the requirement bites for a module in
    // STRICT_FACES, because that is exactly when the lane stops rendering the
    // card and the source loses its host. An UNFACED module is safe today (its
    // card always mounts) and goes red here on the commit that faces it —
    // which is the commit that would otherwise ship it black.
    //
    // What this still cannot see, said plainly: a module whose source is owned
    // by a component through some THIRD seam nobody added to CARD_SOURCE_SEAMS.
    // The per-seam vacuity check above is the partial defence; the def-anchored
    // check below is the other half.
    const { types } = cardSourceTypes();
    const problems: string[] = [];
    const queued: string[] = [];
    for (const type of [...types].sort()) {
      const headless = DOM_SOURCE_LANE_TYPES.has(type);
      const faceMounts = FACE_MOUNTS_SOURCE[type];
      if (!STRICT_FACES.has(type) && !headless && !faceMounts) {
        queued.push(type);
        continue;
      }
      if (headless && faceMounts) {
        problems.push(
          `${type}: declared BOTH in DOM_SOURCE_LANE_TYPES and FACE_MOUNTS_SOURCE — that would ` +
            'mount the renderer twice for one node, and whichever unmounted last would tear down ' +
            "the survivor's source. Pick one.",
        );
        continue;
      }
      if (!headless && !faceMounts) {
        problems.push(
          `${type}: its source lives on a mounted component, and NOTHING says what keeps that ` +
            'component alive when the shell swaps the lane card away. Add it to ' +
            'DOM_SOURCE_LANE_TYPES (the card is kept off-screen) or to FACE_MOUNTS_SOURCE (the ' +
            'face mounts the renderer itself, the cube shape). Left undeclared, this module ships ' +
            'a BLACK output the day it joins STRICT_FACES.',
        );
      }
    }
    expect(problems.join('\n')).toBe('');
    // Not an assertion — the QUEUE, printed so the size of the trap is visible
    // rather than inferred. Each of these breaks on the commit that faces it.
    if (queued.length) {
      // eslint-disable-next-line no-console
      console.log(
        `[dom-source] ${queued.length} unfaced module(s) with a card-owned source, each of which ` +
          `must declare here on the commit that faces it: ${queued.join(', ')}`,
      );
    }
  });

  it('…and every DECLARED entry is still TRUE (a stale exemption is one nobody is watching)', () => {
    const { types } = cardSourceTypes();
    const stale: string[] = [];
    for (const type of DOM_SOURCE_LANE_TYPES) {
      if (!types.has(type)) {
        stale.push(
          `${type} is in DOM_SOURCE_LANE_TYPES but NO component installs a source for it any more — ` +
            'the headless mount is now pure cost. Remove it.',
        );
      }
    }
    for (const [type, entry] of Object.entries(FACE_MOUNTS_SOURCE)) {
      const comp = allModuleComponents().find((c) => c.base === entry.component);
      if (!comp) {
        stale.push(`${type}: FACE_MOUNTS_SOURCE names ${entry.component}.svelte, which does not exist`);
      } else if (!hasCardSource(comp.src)) {
        stale.push(
          `${type}: FACE_MOUNTS_SOURCE names ${entry.component}.svelte, which installs NO source — ` +
            'the claim that the face keeps the renderer alive is false',
        );
      }
    }
    expect(stale.join('\n')).toBe('');
  });

  it('ANCHORED TO THE ARTIFACT: every module def that publishes a frame registry is covered', () => {
    // The list-anchored checks above can only see components. This one reads
    // the DEFS — so a module that ships an `install<X>FrameDrawer` registry is
    // caught on the day the REGISTRY is written, before any card wires it up
    // and long before anyone tries to face it.
    const declared: string[] = [];
    for (const dir of [AUDIO_DEF_DIR, VIDEO_DEF_DIR]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        const src = readFileSync(`${dir}${f}`, 'utf8');
        const m = /export function install([A-Z][A-Za-z0-9]*)FrameDrawer\s*\(/.exec(src);
        if (m) declared.push(typeFromDrawerSymbol(m[1]!));
      }
    }
    expect(declared.length, 'the def scan found no frame registries at all — the pattern rotted').toBeGreaterThan(0);
    const unaccounted = declared
      .filter((t) => STRICT_FACES.has(t) && !DOM_SOURCE_LANE_TYPES.has(t) && !FACE_MOUNTS_SOURCE[t])
      .sort();
    expect(
      unaccounted,
      `module(s) publish a card-installed frame registry with nothing keeping the installer mounted: ` +
        `${unaccounted.join(', ')}. Their video output falls through to the black-fill branch under ?shell=1.`,
    ).toEqual([]);
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
