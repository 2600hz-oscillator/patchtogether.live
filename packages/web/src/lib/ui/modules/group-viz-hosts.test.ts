// packages/web/src/lib/ui/modules/group-viz-hosts.test.ts
//
// THE ANCHOR for the GroupCard viz-host registry (#1721).
//
// The registry exists because TWO consumers need the same answer — GroupCard
// mounts the card, and Canvas's headless-source host must NOT mount a second
// copy of it — so the failure this file exists to catch is the two drifting
// apart, or the registry naming something that no longer exists.
//
// ⚠ WHAT THIS GATE CANNOT SEE, stated so a green run is not over-read: it reads
// DECLARATIONS and one IMPORT, never behaviour. It cannot tell you that the
// hidden mount actually runs a draw loop, that the canvas gets portaled, or
// that the producer keeps pumping while the group is collapsed. That is
// e2e/tests/card-producer-lifetime.spec.ts's `#1721` leg, whose mount-count
// assertion reads the DOM and therefore fails both when nobody hosts the card
// and when two hosts do.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import '$lib/audio/modules';
import '$lib/video/modules';
import { getModuleDef, listModuleDefs } from '$lib/audio/module-registry';
import { getVideoModuleDef, listVideoModuleDefs } from '$lib/video/module-registry';

import { GROUP_VIZ_HOST_CARDS, groupCardHostsChildCard } from './group-viz-hosts';

const GROUP_CARD_SRC = readFileSync(
  fileURLToPath(new URL('./GroupCard.svelte', import.meta.url)),
  'utf8',
);

const HOSTED = Object.keys(GROUP_VIZ_HOST_CARDS);

describe('GROUP_VIZ_HOST_CARDS — the registry itself', () => {
  it('is not empty (an empty registry would make every assertion below vacuous)', () => {
    expect(HOSTED.length).toBeGreaterThan(0);
  });

  it('names only REAL module types — a renamed module reddens here', () => {
    const ghosts = HOSTED.filter((t) => !getModuleDef(t) && !getVideoModuleDef(t));
    expect(
      ghosts,
      `registry key(s) with no registered module def: ${ghosts.join(', ')}`,
    ).toEqual([]);
  });

  it('every entry is a def that DECLARES vizPassthrough — the flag is the licence to portal', () => {
    const notDeclared = HOSTED.filter((t) => {
      const def = getModuleDef(t) ?? getVideoModuleDef(t);
      return def?.vizPassthrough !== true;
    });
    expect(
      notDeclared,
      `hosted type(s) whose def does NOT declare vizPassthrough: ${notDeclared.join(', ')}. ` +
        'GroupCard only portals a child that opted in.',
    ).toEqual([]);
  });

  it('is a SUBSET of the vizPassthrough population, and the reverse is deliberately NOT asserted', () => {
    // ⚠ WHY ONLY ONE DIRECTION. Declaring `vizPassthrough` says "my card exposes
    // a portable canvas". It does NOT say GroupCard knows how to mount that
    // card. Defs declare the flag and are not hosted (the game modules), so an
    // EQUALITY here would be a false statement about the product — one a future
    // reader would "fix" by adding a host that does not exist. The direction
    // that must hold is asserted; the other is left alone on purpose.
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
    // pong against SCOPE's 1). That is a real defect, and not one this registry
    // is allowed to hide by pretending the sets are equal. When #1755 closes,
    // the two populations coincide and the equality becomes assertable.
  });

  it('groupCardHostsChildCard agrees with the map, in BOTH directions', () => {
    for (const t of HOSTED) expect(groupCardHostsChildCard(t), `${t} is a key`).toBe(true);
    // PERMANENT NEGATIVE CONTROL: a predicate that answered `true` for
    // everything would satisfy every assertion above. Two shapes of non-member —
    // a real module that is NOT hosted, and a name that does not exist at all.
    expect(groupCardHostsChildCard('wavesculpt'), 'a producer GroupCard does NOT host').toBe(false);
    expect(groupCardHostsChildCard('__no_such_module__')).toBe(false);
    // ...and it must not answer for inherited Object keys.
    expect(groupCardHostsChildCard('toString')).toBe(false);
    expect(groupCardHostsChildCard('constructor')).toBe(false);
  });
});

describe('GroupCard reads the registry — the two consumers cannot drift', () => {
  it('IMPORTS the shared registry (matched structurally, not by prose)', () => {
    // ⚠ ANCHORED ON THE IMPORT STATEMENT, at line start. A looser
    // `/GROUP_VIZ_HOST_CARDS/` would be satisfied by this very comment, and a
    // pattern that strips `//` lines first eats string literals containing `//`
    // — both failure modes this repo has actually shipped. `^\s*import` cannot
    // match a `// import …` line.
    const importRe =
      /^\s*import\s*\{[^}]*\bGROUP_VIZ_HOST_CARDS\b[^}]*\}\s*from\s*['"][^'"]*group-viz-hosts['"]/m;
    expect(
      importRe.test(GROUP_CARD_SRC),
      'GroupCard.svelte must import GROUP_VIZ_HOST_CARDS from $lib/ui/modules/group-viz-hosts',
    ).toBe(true);
  });

  it('imports NO card component directly — the registry is the only way in', () => {
    // Deny by default: any `import X from '…SomethingCard.svelte'` in GroupCard
    // is a second, unregistered mounting path, which is exactly the drift the
    // registry removes. Line-anchored for the same reason as above.
    const direct = [...GROUP_CARD_SRC.matchAll(/^\s*import\s+(\w+)\s+from\s+['"]([^'"]*Card\.svelte)['"]/gm)]
      .map((m) => `${m[1]} from ${m[2]}`);
    expect(
      direct,
      `GroupCard.svelte imports card component(s) directly: ${direct.join(', ')}. ` +
        'Register them in $lib/ui/modules/group-viz-hosts instead, so Canvas sees them too.',
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: both source patterns can FAIL, on a tree that lacks them', () => {
    // The instrument, perturbed in the direction that matters — a green run
    // above must mean "the import is there", not "the regex never fires".
    const withoutImport = GROUP_CARD_SRC.replace(
      /^\s*import\s*\{[^}]*\bGROUP_VIZ_HOST_CARDS\b[^}]*\}[^\n]*\n/m,
      '',
    );
    expect(
      /^\s*import\s*\{[^}]*\bGROUP_VIZ_HOST_CARDS\b[^}]*\}\s*from\s*['"][^'"]*group-viz-hosts['"]/m.test(
        withoutImport,
      ),
    ).toBe(false);
    const withDirect = `${GROUP_CARD_SRC}\nimport ScopeCard from '$lib/ui/modules/ScopeCard.svelte';\n`;
    expect(
      [...withDirect.matchAll(/^\s*import\s+(\w+)\s+from\s+['"]([^'"]*Card\.svelte)['"]/gm)].length,
    ).toBeGreaterThan(0);
    // ...and a COMMENT naming either one does not fire, which is the failure
    // mode that made an earlier gate red on its own fix's explanation.
    const commentedOnly = `// import ScopeCard from './ScopeCard.svelte';\n// GROUP_VIZ_HOST_CARDS is the registry\n`;
    expect(
      [...commentedOnly.matchAll(/^\s*import\s+(\w+)\s+from\s+['"]([^'"]*Card\.svelte)['"]/gm)].length,
    ).toBe(0);
  });
});
