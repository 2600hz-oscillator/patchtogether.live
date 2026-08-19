// packages/web/src/lib/ui/workflow/video-face-screen-source.test.ts
//
// THE #1928 CLOSE — every FACED video module must be able to reach its SCREEN
// ON/OFF switch from the faceplate that replaced its card.
//
// THE RULING (owner, 2026-08-18): *"'screen on / off' on the card like that is
// a thing all video modules should have moving forward."*
//
// THE DEFECT IT CLOSES, and why nothing else could see it. Promotion sets
// `migrated(type)` true, and from that moment neither surface renders the
// module's `*Card.svelte` (`DockFullView.svelte:319` mounts `<ModuleShell>`
// instead). So a toggle authored ON THE CARD is DELETED BY THE PROMOTION THAT
// WAS SUPPOSED TO KEEP IT. `spirographs` shipped exactly that and #1930
// repaired it; the skill's own SCREEN paragraph names the missing check —
// *"a deny-by-default check over `STRICT_FACES ∩ video defs` is the honest
// close and does not exist yet (#1928)"*. This is that check.
//
// ⚠ WHAT THIS GATE IS STRUCTURALLY UNABLE TO SEE, stated inside the gate as
// the blind-gates rule requires:
//
//   * It reads SOURCE, not a render. It cannot tell you the button is visible,
//     clickable, or wired to anything — only that the faced module owns a
//     `fullViewBody` whose source carries a screen switch over the shared
//     `previewCollapsed` key. The RENDER half is e2e's job.
//   * It cannot see a module that is NOT in `STRICT_FACES`. An un-migrated
//     video module's card toggle is out of scope here by construction — that
//     half of the ruling is the card's, and this gate is about the half that
//     promotion destroys.
//   * `import.meta.glob` in `shell-extensions.ts` is LAZY, so this cannot
//     resolve the component object; it resolves the FILE the declaration names
//     and reads it. A `shell-extension.ts` that compiles but exports the wrong
//     slot would be caught by `shell-extensions.test.ts`, not here.
//
// DENY BY DEFAULT: a faced video module with no entry below must satisfy the
// rule. An exemption is per MODULE and carries a `why` — and it is ANCHORED,
// so an exemption naming a module that is no longer a faced video def is RED
// rather than quietly permitting the next one.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVideoModuleDefs } from '$lib/video/module-registry';
import { STRICT_FACES } from './strict-faces';
import '$lib/video/modules';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = resolve(HERE, '../modules');

/**
 * Faced video modules that legitimately do NOT own a screen switch.
 *
 * Each entry is a `(type, why)` pair. Empty today, and that is the point: the
 * rule holds for every faced video module in the tree with no carve-outs, so
 * adding one is a visible decision rather than a quiet default.
 */
const NO_SCREEN_SWITCH: readonly { type: string; why: string }[] = [
  {
    type: 'videoOut',
    why:
      'videoOut IS the screen — its faceplate body is the output picture itself, and its own '
      + 'header says so ("what OUTPUT *is* is a SCREEN, so its faceplate is the screen"). A '
      + 'SCREEN ON/OFF here would collapse the module\'s entire reason to exist rather than '
      + 'reclaiming space beside it; the ruling is about a preview that sits NEXT TO a module\'s '
      + 'controls. Its fullViewBody carries the affordances that are meaningful for a screen '
      + 'instead — fullscreen, and detach-to-second-display.',
  },
];

/** Every video module that has been promoted — the gate's subject. */
function facedVideoTypes(): string[] {
  return listVideoModuleDefs()
    .filter((d) => STRICT_FACES.has(d.type))
    .map((d) => d.type)
    .sort();
}

function extensionSource(extId: string): string | null {
  const file = resolve(MODULES_DIR, extId, 'shell-extension.ts');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** The component file a `shell-extension.ts` names for its fullViewBody slot. */
function fullViewBodySource(extId: string): string | null {
  const src = extensionSource(extId);
  if (!src) return null;
  const m = /fullViewBody:\s*([A-Za-z0-9_]+)/.exec(src);
  if (!m) return null;
  const imported = new RegExp(`import\\s+${m[1]}\\s+from\\s+'\\./([^']+)'`).exec(src);
  if (!imported) return null;
  const file = resolve(MODULES_DIR, extId, imported[1]);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

describe('#1928 — a faced VIDEO module keeps its SCREEN switch', () => {
  it('has a subject at all (vacuity control)', () => {
    // A gate over an empty set is green and proves nothing. If every video
    // face were somehow unregistered, THIS fails rather than the sweep below
    // passing silently.
    expect(facedVideoTypes().length, 'faced video modules found').toBeGreaterThan(0);
  });

  it('every faced video module declares a face.extension', () => {
    const exempt = new Set(NO_SCREEN_SWITCH.map((e) => e.type));
    const missing = listVideoModuleDefs()
      .filter((d) => STRICT_FACES.has(d.type) && !exempt.has(d.type))
      .filter((d) => !d.face?.extension)
      .map((d) => d.type)
      .sort();
    expect(
      missing,
      'a promoted video module whose face declares no `extension` has NO route to its SCREEN ' +
        'toggle: promotion stops both surfaces rendering its card, and `previewCollapsed` ' +
        'appears in zero shell files. Declare `face.extension: "<id>"` and add ' +
        '$lib/ui/modules/<id>/shell-extension.ts exposing `fullViewBody` (backdraft / videoOut / ' +
        'spirographs / mirrorpool are the adopters to copy).',
    ).toEqual([]);
  });

  it('every declared extension resolves to a fullViewBody carrying the switch', () => {
    const exempt = new Set(NO_SCREEN_SWITCH.map((e) => e.type));
    const offenders: string[] = [];
    for (const def of listVideoModuleDefs()) {
      if (!STRICT_FACES.has(def.type) || exempt.has(def.type)) continue;
      const extId = def.face?.extension;
      if (!extId) continue; // reported by the test above
      const src = fullViewBodySource(extId);
      if (src === null) {
        offenders.push(`${def.type}: extension '${extId}' has no resolvable fullViewBody component`);
        continue;
      }
      // ⚠ THE PREDICATE IS SEMANTIC, NOT A NAMING CONVENTION — and the first
      // run of this gate is why. It originally required a
      // `data-testid="*screen-toggle"`, and reported `backdraft` as an
      // offender: backdraft has the control, spelled
      // `backdraft-preview-toggle`. A gate that fails on a NAME while the
      // BEHAVIOUR is present is a false positive that gets "fixed" by renaming
      // a testid, which changes nothing. Three legs, all about what the source
      // can DO:
      //   * it READS the shared key (so it shows the right state), and
      //   * it WRITES it through the node-data idiom (so it can actually
      //     toggle — a body that only reads cannot turn the screen off), and
      //   * it exposes a <button> (so a player can reach it).
      if (!src.includes('previewCollapsed')) {
        offenders.push(`${def.type}: fullViewBody never reads \`previewCollapsed\``);
      }
      if (!/\.data\.previewCollapsed\s*=/.test(src)) {
        offenders.push(`${def.type}: fullViewBody never WRITES \`previewCollapsed\` — it cannot toggle`);
      }
      if (!/<button/.test(src)) {
        offenders.push(`${def.type}: fullViewBody exposes no <button> to toggle it`);
      }
    }
    expect(
      offenders,
      'the SCREEN toggle must live on the FACE, over the same `previewCollapsed` key the card ' +
        'uses — a different key silently re-opens every preview collapsed before the promotion.',
    ).toEqual([]);
  });

  // ── The exemption list is ANCHORED, not a bucket ─────────────────────────
  it('every exemption still names a faced video module', () => {
    const faced = new Set(facedVideoTypes());
    const dead = NO_SCREEN_SWITCH.filter((e) => !faced.has(e.type)).map((e) => e.type);
    expect(
      dead,
      'an exemption naming a module that is no longer a faced video def is stale — delete it, ' +
        'or it will quietly permit the next module that takes the same name.',
    ).toEqual([]);
  });

  it('every exemption carries a real reason', () => {
    const thin = NO_SCREEN_SWITCH.filter((e) => (e.why ?? '').trim().length < 40).map((e) => e.type);
    expect(thin, 'an exemption needs an argument, not a label').toEqual([]);
  });

  // ── The instrument's own negative control ────────────────────────────────
  it('the predicate REJECTS a face with no extension (negative control)', () => {
    // The same two predicates the sweep uses, against a fixture that is wrong
    // in each way. Without this, a sweep that silently matched nothing — a
    // broken path, a renamed directory — would look identical to a green one.
    expect(fullViewBodySource('definitely-not-a-module')).toBeNull();
    const real = fullViewBodySource('backdraft');
    expect(real, 'backdraft fullViewBody source').not.toBeNull();
    expect(real!.includes('previewCollapsed')).toBe(true);
    expect(/\.data\.previewCollapsed\s*=/.test(real!)).toBe(true);
    expect(/<button/.test(real!)).toBe(true);
    // …and each predicate must be able to say NO. A source that merely READS
    // the key is the interesting negative: it looks compliant to a substring
    // check and cannot toggle anything.
    const readOnly = '<button>x</button> const c = node.data.previewCollapsed ?? false;';
    expect(readOnly.includes('previewCollapsed')).toBe(true);
    expect(/\.data\.previewCollapsed\s*=/.test(readOnly), 'read-only source must fail the WRITE leg').toBe(false);
    expect(/<button/.test('<div>no control here</div>')).toBe(false);
  });
});
