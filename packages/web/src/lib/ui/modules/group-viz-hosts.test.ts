// packages/web/src/lib/ui/modules/group-viz-hosts.test.ts
//
// THE ANCHOR for the GroupCard viz-host split (#1721).
//
// TWO consumers need one answer — GroupCard mounts the card, and Canvas's
// headless-source host must NOT mount a second copy of it — so the failure this
// file exists to catch is the two drifting apart, or either half naming
// something that no longer exists.
//
// ⚠ WHY THE SPLIT IS SHAPED THIS WAY, because the obvious simplification is the
// thing that was already caught once. Putting the `type → CardComponent` map in
// the shared `.ts` and importing it from GroupCard removes GroupCard's direct
// `.svelte` import — and `dom-source-modules.test.ts`'s subtree walk
// (#1724/#1749) follows `.svelte` edges and STOPS AT `.ts`, by a measured
// decision (following `.ts` enrols all 195 cards through `$lib/video/engine.ts`).
// That draft put a live component mount inside the walk's declared blind spot
// and its `GroupCard → ScopeCard.svelte` exemption went stale on the spot. So
// the TYPE IDS are shared and the COMPONENT is imported directly, and the last
// two tests here hold that arrangement in place from both sides.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated so a green run is not over-read: it reads
// DECLARATIONS and IMPORTS, never behaviour. It cannot tell you the hidden mount
// runs a draw loop, that the canvas gets portaled, or that the producer keeps
// pumping while the group is collapsed. That is
// e2e/tests/card-producer-lifetime.spec.ts's `#1721` leg, whose mount-count
// assertion reads the real DOM and so fails both when nobody hosts the card and
// when two hosts do.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import { getModuleDef, listModuleDefs } from '$lib/audio/module-registry';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';
import { conventionalCardName } from '$lib/ui/modules-card-map';

import { GROUP_VIZ_HOST_TYPES, groupCardHostsChildCard } from './group-viz-hosts';

const GROUP_CARD_SRC = readFileSync(
  fileURLToPath(new URL('./GroupCard.svelte', import.meta.url)),
  'utf8',
);

const HOSTED = [...GROUP_VIZ_HOST_TYPES];

/** The card-component basename the app's own resolver would use for a type. */
function cardBasenameFor(type: string): string {
  const def = getModuleDef(type) ?? getVideoModuleDef(type);
  return (def as { card?: string } | undefined)?.card ?? conventionalCardName(type);
}

/**
 * The KEYS of GroupCard's `HOST_CARDS` map, parsed from its source.
 *
 * ANCHORED ON THE DECLARATION: it throws rather than returning `[]` if the shape
 * moves, because a parse that silently comes back empty would make the equality
 * below pass by matching nothing — the exact vacuity this repo keeps re-learning.
 */
function groupCardHostKeys(): string[] {
  const m = /const\s+HOST_CARDS\s*:[^=]*=\s*\{([^}]*)\}/.exec(GROUP_CARD_SRC);
  if (!m) throw new Error('could not find GroupCard HOST_CARDS — has the shape changed?');
  return [...m[1]!.matchAll(/(\w+)\s*:/g)].map((k) => k[1]!);
}

describe('GROUP_VIZ_HOST_TYPES — the shared membership truth', () => {
  it('is not empty (an empty set would make every assertion below vacuous)', () => {
    expect(HOSTED.length).toBeGreaterThan(0);
  });

  it('names only REAL module types — a renamed module reddens here', () => {
    const ghosts = HOSTED.filter((t) => !getModuleDef(t) && !getVideoModuleDef(t));
    expect(ghosts, `hosted type(s) with no registered module def: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('every entry is a def that DECLARES vizPassthrough — the flag is the licence to portal', () => {
    const notDeclared = HOSTED.filter((t) => {
      const def = getModuleDef(t) ?? getVideoModuleDef(t);
      return (def as { vizPassthrough?: boolean } | undefined)?.vizPassthrough !== true;
    });
    expect(
      notDeclared,
      `hosted type(s) whose def does NOT declare vizPassthrough: ${notDeclared.join(', ')}. ` +
        'GroupCard only portals a child that opted in.',
    ).toEqual([]);
  });

  it('is a SUBSET of the vizPassthrough population, and the reverse is deliberately NOT asserted', () => {
    // ⚠ WHY ONLY ONE DIRECTION. Declaring `vizPassthrough` says "my card exposes
    // a portable canvas". It does NOT say GroupCard mounts that card. Defs
    // declare the flag and are not mounted, so an EQUALITY here would be a false
    // statement about the product — one a future reader would "fix" by inventing
    // a host that does not exist.
    const declaring = new Set<string>();
    for (const def of [...listModuleDefs(), ...listVideoModuleDefs()]) {
      if ((def as { vizPassthrough?: boolean }).vizPassthrough === true) declaring.add(def.type);
    }
    const notDeclaring = HOSTED.filter((t) => !declaring.has(t));
    expect(notDeclaring, `hosted but not vizPassthrough: ${notDeclaring.join(', ')}`).toEqual([]);
    // The reverse — every declaring def is hosted — is NOT asserted, and must
    // not be added. It is false today (#1755: the game modules declare the flag
    // and GroupCard mounts no card for them, so a collapsed group around one
    // shows an EMPTY viz slot — measured `canvasInSlot 0` for frogger/modtris/
    // pong against SCOPE's 1). When #1755 closes the two populations coincide
    // and the equality becomes assertable.
  });

  it('groupCardHostsChildCard agrees with the set, in BOTH directions', () => {
    for (const t of HOSTED) expect(groupCardHostsChildCard(t), `${t} is a member`).toBe(true);
    // PERMANENT NEGATIVE CONTROL: a predicate answering `true` for everything
    // satisfies every assertion above. Three shapes of non-member — a real
    // module that is not hosted, a name that does not exist, and an inherited
    // Object key (the reason this is a Set and not an object literal).
    expect(groupCardHostsChildCard('wavesculpt'), 'a producer GroupCard does NOT host').toBe(false);
    expect(groupCardHostsChildCard('__no_such_module__')).toBe(false);
    expect(groupCardHostsChildCard('toString')).toBe(false);
    expect(groupCardHostsChildCard('constructor')).toBe(false);
  });
});

describe('GroupCard and the shared set cannot drift', () => {
  it("GroupCard's HOST_CARDS keys are EXACTLY the shared set, both directions", () => {
    const keys = groupCardHostKeys();
    // Both directions spelled out, because each catches a different real bug: a
    // key with no set entry is a component Canvas does not know about (Canvas
    // would headless-mount a node GroupCard is already mounting — a double
    // mount); a set entry with no key is a type Canvas believes is hosted while
    // GroupCard renders an empty viz slot for it (#1755's shape, but silent).
    expect([...keys].sort(), 'GroupCard HOST_CARDS vs GROUP_VIZ_HOST_TYPES').toEqual(
      [...HOSTED].sort(),
    );
  });

  it('GroupCard imports each hosted card DIRECTLY as a .svelte edge (the subtree walk depends on it)', () => {
    // ⚠ THE INVARIANT THAT REPLACED ITS OWN OPPOSITE. An earlier draft of #1721
    // asserted GroupCard imports NO card component directly, because the map
    // lived in a shared `.ts`. That is backwards: `dom-source-modules.test.ts`'s
    // subtree walk follows `.svelte` imports and stops at `.ts`, so routing the
    // component through a registry hides this mount from the gate and staled its
    // `GroupCard → ScopeCard.svelte` exemption. Each hosted card must be reachable
    // from GroupCard by a DIRECT component edge.
    const missing = HOSTED.filter((t) => {
      const base = cardBasenameFor(t);
      // Line-anchored on the import STATEMENT: a `// import …` comment cannot
      // match, and a pattern that stripped `//` lines first would eat string
      // literals containing `//` — both failure modes this repo has shipped.
      const re = new RegExp(`^\\s*import\\s+\\w+\\s+from\\s+['"][^'"]*${base}\\.svelte['"]`, 'm');
      return !re.test(GROUP_CARD_SRC);
    });
    expect(
      missing,
      `hosted type(s) whose card is NOT directly imported by GroupCard.svelte: ${missing
        .map((t) => `${t} (${cardBasenameFor(t)}.svelte)`)
        .join(', ')}. Import it directly — routing it through a .ts registry makes the mount ` +
        'invisible to the dom-source-modules subtree walk.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: both source readers can FAIL, and neither fires on prose', () => {
    // The instruments, perturbed in the direction that matters — a green run
    // above must mean "it is there", not "the pattern never fires".
    const importRe = (base: string) =>
      new RegExp(`^\\s*import\\s+\\w+\\s+from\\s+['"][^'"]*${base}\\.svelte['"]`, 'm');
    const base = cardBasenameFor(HOSTED[0]!);
    expect(importRe(base).test(GROUP_CARD_SRC), 'the real import matches').toBe(true);
    expect(
      importRe(base).test(GROUP_CARD_SRC.replace(new RegExp(`^\\s*import[^\\n]*${base}[^\\n]*\\n`, 'm'), '')),
      'and stops matching when the import line is removed',
    ).toBe(false);
    expect(
      importRe(base).test(`// import ${base} from './${base}.svelte';\n`),
      'a COMMENTED import must NOT satisfy it — the failure mode that reddened a fix on its own prose',
    ).toBe(false);
    // ...and the HOST_CARDS parse throws rather than returning empty when the
    // declaration is gone, so the equality above can never pass vacuously.
    const withoutMap = GROUP_CARD_SRC.replace(/const\s+HOST_CARDS/, 'const RENAMED_AWAY');
    expect(() => {
      const m = /const\s+HOST_CARDS\s*:[^=]*=\s*\{([^}]*)\}/.exec(withoutMap);
      if (!m) throw new Error('could not find GroupCard HOST_CARDS — has the shape changed?');
      return m;
    }).toThrow(/HOST_CARDS/);
  });
});
