// The factory owns the game; surfaces may blit it but never create or dispose it.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripSourceCommentsWithReport } from '$lib/source-guards/strip-source-comments';
import {
  ensureSkifreeBridge,
  releaseSkifreeController,
  releaseSkifreeGate,
} from './skifree-bridge';
import type { SkifreeBridge, SkifreeController } from './modules/skifree';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SRC = resolve(HERE, 'skifree-bridge.ts');
// ⚠ THE SURFACE UNDER TEST WAS `SkifreeCard.svelte` and is now the shared
// screen every skifree surface mounts. The claims are unchanged: the surface
// must not create, dispose or load the game, and must not re-parent the
// game canvas — it BLITS.
const SURFACE_SRC = resolve(HERE, '../ui/modules/skifree/SkifreeScreen.svelte');
const DEF_SRC = resolve(HERE, 'modules/skifree.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Comment examples must not satisfy source guards.
function codeOf(p: string): { code: string; stripped: number } {
  const { text, report } = stripSourceCommentsWithReport(read(p));
  return { code: text, stripped: report.line + report.block + report.html };
}

function isSkifreeScreenSource(source: string): boolean {
  const { text } = stripSourceCommentsWithReport(source);
  return /\bSkifreeSnapshot\b/.test(text) && /<canvas\b[^>]*\bbind:this=\{canvasEl\}/.test(text);
}

function peek(): SkifreeBridge | undefined {
  return (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
}

/** A stand-in controller — identity is all these tests compare. */
function fakeController(): SkifreeController {
  return {} as unknown as SkifreeController;
}

beforeEach(() => {
  delete (globalThis as unknown as { __skifree?: unknown }).__skifree;
});

describe('one owner, one bridge', () => {
  it('ensure is idempotent and shared — one object, not two shapes', () => {
    const a = ensureSkifreeBridge();
    const b = ensureSkifreeBridge();
    expect(a).toBe(b);
    expect(a).toEqual({ controller: null, onGate: null, cvDriven: false });
  });

  it('the factory can clear its OWN callback', () => {
    const bridge = ensureSkifreeBridge();
    const onGate = (): void => {};
    bridge.onGate = onGate;
    releaseSkifreeGate(onGate);
    expect(peek()?.onGate).toBeNull();
  });

  it('the factory will not clobber a NEWER callback than its own', () => {
    // A re-materialized node installs a newer callback before the older
    // materialization's dispose runs. Clearing unconditionally there would kill
    // GATE on the LIVE node — #1590's damage by a different route.
    const bridge = ensureSkifreeBridge();
    const older = (): void => {};
    const newer = (): void => {};
    bridge.onGate = older;
    bridge.onGate = newer;
    releaseSkifreeGate(older);
    expect(peek()?.onGate, 'the newer callback must survive').toBe(newer);
  });

  it('the controller release is identity-checked the same way', () => {
    const bridge = ensureSkifreeBridge();
    const older = fakeController();
    const newer = fakeController();
    bridge.controller = older;
    bridge.controller = newer;
    releaseSkifreeController(older);
    expect(peek()?.controller, 'the newer controller must survive').toBe(newer);
    releaseSkifreeController(newer);
    expect(peek()?.controller).toBeNull();
  });

  it('releasing before anything exists is a no-op, not a crash', () => {
    expect(() => releaseSkifreeGate(null)).not.toThrow();
    expect(() => releaseSkifreeController(null)).not.toThrow();
    expect(peek(), 'and nothing is conjured into existence').toBeUndefined();
  });

  it('NEGATIVE CONTROL: the identity check really discriminates', () => {
    // Every assertion above would also pass against a `release` that cleared
    // unconditionally — the survivor tests would fail, but a reader could
    // believe the guard is "it clears" rather than "it clears MINE". This is
    // the other direction: the matching value really is cleared.
    const bridge = ensureSkifreeBridge();
    const mine = fakeController();
    bridge.controller = mine;
    releaseSkifreeController(mine);
    expect(peek()?.controller).toBeNull();
  });
});

describe('#1590 is UNSPELLABLE — the source-level guards', () => {
  it('the bridge exposes no card-facing release and no way to remove the container', async () => {
    const mod = (await import('./skifree-bridge')) as Record<string, unknown>;
    for (const banned of [
      'releaseSkifreeCardState', // the card-facing release, deleted
      'deleteBridge',
      'resetBridge',
      'disposeBridge',
    ]) {
      expect(mod[banned], `\`${banned}\` must not exist — the absence IS the guard`).toBeUndefined();
    }
  });

  it('THE SURFACE CREATES NO GAME: it never calls SkiFree.create and never disposes a controller', () => {
    // ⚠ SOURCE-LEVEL, because no runtime gate can see this. The surface
    // rendering fine and the game being owned by the wrong thing look identical
    // from the DOM — that is precisely how this shipped.
    const { code: card } = codeOf(SURFACE_SRC);
    expect(card.length, 'and there is still code left to test').toBeGreaterThan(500);

    expect(/SkiFree\s*\.\s*create/.test(card), 'the SURFACE must not create the game').toBe(false);
    expect(
      /controller\s*\.\s*dispose\s*\(/.test(card),
      'the SURFACE must not dispose the game — a collapse is not a quit',
    ).toBe(false);
    expect(
      card.includes('skifree.bundle.js'),
      'the SURFACE must not load the bundle; the node does',
    ).toBe(false);

    // ⚠ NEGATIVE CONTROL FOR THE PREDICATES THEMSELVES. All three tests above
    // are absence checks, so a typo'd regex would pass on any file at all. Run
    // the SAME patterns against the FACTORY, where all three must HIT.
    const { code: def } = codeOf(DEF_SRC);
    expect(/SkiFree\s*\.\s*create/.test(def), 'the create pattern really matches somewhere').toBe(true);
    expect(def.includes('skifree.bundle.js') || def.includes('SKIFREE_BUNDLE_SRC'),
      'the bundle-source pattern really matches somewhere').toBe(true);
  });

  it('THE FACTORY DOES: it loads the bundle, creates the game, and disposes it', () => {
    // The positive half. Without it the test above passes just as well against
    // a build where NOBODY owns the game, which is the state this whole change
    // exists to leave.
    const { code: def } = codeOf(DEF_SRC);
    expect(def.includes('ensureSkifreeBundle'), 'the factory loads the bundle').toBe(true);
    expect(/SkiFree\s*\.\s*create/.test(def), 'the factory creates the game').toBe(true);
    expect(
      def.includes('releaseSkifreeController'),
      'the factory releases the game at NODE dispose',
    ).toBe(true);
  });

  it('the canvas the game runs on is never given a parent', () => {
    // The cameraInput trap: a DOM node has exactly one parent, so appending the
    // owned canvas anywhere — or letting a surface adopt it — would hand the
    // game's canvas to something that unmounts. The surface BLITS instead.
    const { code: def } = codeOf(DEF_SRC);
    expect(
      /appendChild\s*\(\s*gameCanvas/.test(def),
      'the game canvas must stay detached',
    ).toBe(false);
    const { code: card } = codeOf(SURFACE_SRC);
    expect(
      /appendChild|replaceChildren|insertBefore/.test(card),
      'the surface must not re-parent anything',
    ).toBe(false);
    expect(card.includes('drawImage'), 'the surface blits the picture instead').toBe(true);
  });

  it('SELF-CHECK: the source files this gate reads are real and non-trivial', () => {
    // Three ways this describe block could be green while measuring nothing: a
    // wrong path, an empty read, or a rename. All three fail HERE rather than
    // letting four `false` assertions pass over missing text.
    for (const [name, p] of [['bridge', BRIDGE_SRC], ['surface', SURFACE_SRC], ['def', DEF_SRC]] as const) {
      expect(read(p).length, `${name} source is readable and non-empty`).toBeGreaterThan(500);
    }
    expect(
      isSkifreeScreenSource(read(SURFACE_SRC)),
      'the surface path resolves to the shared screen',
    ).toBe(true);
    expect(read(DEF_SRC).includes('skifreeDef'), 'the def path resolves to the def').toBe(true);
  });

  it('the surface self-check requires code, not a filename or commented-out markup', () => {
    expect(isSkifreeScreenSource('// SkifreeScreen.svelte')).toBe(false);
    expect(isSkifreeScreenSource(
      '/* SkifreeSnapshot */\n<!-- <canvas bind:this={canvasEl}></canvas> -->',
    )).toBe(false);
    const source = read(SURFACE_SRC);
    expect(isSkifreeScreenSource(source)).toBe(true);
    expect(isSkifreeScreenSource(stripSourceCommentsWithReport(source).text)).toBe(true);
    expect(isSkifreeScreenSource(source.replace(/\bSkifreeSnapshot\b/g, 'UnrelatedSnapshot'))).toBe(false);
    expect(isSkifreeScreenSource(source.replace(/<canvas\b/g, '<div'))).toBe(false);
  });
});
