// e2e/vrt/vrt-audio-freeze.ts
//
// FREEZE THE AUDIO GRAPH — AND PROVE IT ACTUALLY FROZE.
//
// ─────────────────────────────────────────────────────────────────────────
// THE BUG THIS FILE EXISTS FOR: THE VRT AUDIO FREEZE WAS A SILENT NO-OP.
//
// Nineteen VRT specs and both scene registries contained some spelling of:
//
//     const eng = w.__engine?.();
//     if (!eng) return;
//     try { await eng.ctx.suspend(); } catch { /* already suspended */ }
//
// `__engine()` returns the ROOT engine. The root engine has NO `ctx`
// property — the AudioContext lives on the AUDIO DOMAIN
// (`engine.getDomain('audio').ctx`; see engine.ts, which uses exactly that
// spelling internally, e.g. `createEdgeCounter({ ctx: ae.ctx, … })`).
//
// So `eng.ctx.suspend()` threw `TypeError: Cannot read properties of
// undefined (reading 'suspend')` on EVERY call, the surrounding
// `catch { /* already suspended */ }` swallowed it, and the context was never
// suspended once. MEASURED 2026-08-01 with a probe that resolves both spellings
// and prints which one exists (e2e/vrt/vrt-sr-probe.spec.ts):
//
//     sampleRate=48000 state=running hasDirectCtx=false hasDomainCtx=true
//     engineKeys=[domains,cvBridgeEdgeIds,videoTextureBridgeEdgeIds,…]
//
// `state=running` AFTER the freeze is the whole finding. Every comment in
// vrt-scenes.ts and vrt-composite-scenes.ts promising that "we SUSPEND the
// AudioContext so the analyser-driven trace freezes → pixel-stable across
// runs" described a mechanism that has never run.
//
// ⚠ THIS IS THE CLAUDE.md INSTRUMENT RULE IN ITS PUREST FORM. A `try/catch`
// wrapped around an operation whose EFFECT is never asserted converts a broken
// mechanism into a silent success. The catch was even commented "already
// suspended", which reads as a considered decision and is in fact the thing
// hiding the defect. Compare vrt-capture.ts's negative control, which forces a
// surface to opacity:0 and then VERIFIES the computed opacity really is 0
// before trusting the measurement — that discipline is what was missing here.
//
// It also retro-explains the scope saga: `scope` needed the `__scopeVrtSeed`
// synthetic-buffer pin because the freeze that was supposed to stabilise it
// never happened, and the `snh` ch2 note's "freezing the AudioContext pins the
// buffer's CONTENTS but not WHICH buffer was last posted" was reasoning about
// a freeze that did not occur. (The `snh` scenes still pass 10/10 because a
// HELD DC level has no time-domain phase — the running audio could not hurt
// them. That is luck, not design.)
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS HELPER DOES DIFFERENTLY
//
//   1. Resolves the AudioContext through BOTH spellings, so it keeps working
//      if the root engine ever grows a `ctx` shortcut.
//   2. Returns the context state it OBSERVED after suspending.
//   3. `freezeAudioContext()` THROWS when the state is not 'suspended'. An
//      inert freeze is now a loud failure instead of a comment.
//
// A caller that legitimately has no audio engine (a pure-video scene) should
// not call this at all rather than tolerate a silent skip.

import type { Page } from '@playwright/test';

export type FreezeVerdict =
  | { ok: true; state: 'suspended' }
  | { ok: false; reason: 'no-engine' | 'no-ctx' | 'not-suspended'; state: string | null };

/** Suspend the audio graph and REPORT what actually happened. Never throws —
 *  use `freezeAudioContext` for the throwing form. */
export async function tryFreezeAudioContext(page: Page): Promise<FreezeVerdict> {
  const r = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __engine?: () => Record<string, unknown> | null;
    };
    const eng = w.__engine?.();
    if (!eng) return { reason: 'no-engine' as const, state: null };
    const ctx =
      (eng as { ctx?: AudioContext }).ctx ??
      (eng as { getDomain?: (d: string) => { ctx?: AudioContext } }).getDomain?.('audio')?.ctx;
    if (!ctx) return { reason: 'no-ctx' as const, state: null };
    try {
      await ctx.suspend();
    } catch {
      /* already suspended / closed — the state check below is the real verdict */
    }
    return { reason: null, state: ctx.state as string };
  });
  if (r.reason) return { ok: false, reason: r.reason, state: r.state };
  if (r.state !== 'suspended') return { ok: false, reason: 'not-suspended', state: r.state };
  return { ok: true, state: 'suspended' };
}

/**
 * Suspend the audio graph, or FAIL. The whole point of the freeze is that the
 * analyser stops advancing; a freeze that quietly did nothing produces a
 * baseline captured from a running graph, which is the flake it was meant to
 * prevent — and it looks identical to success from the call site.
 */
export async function freezeAudioContext(page: Page, label = 'vrt scene'): Promise<void> {
  const v = await tryFreezeAudioContext(page);
  if (v.ok) return;
  throw new Error(
    `${label}: AUDIO FREEZE DID NOT LAND (${v.reason}; ctx.state=${v.state ?? 'n/a'}). ` +
      'The scene asked to suspend the AudioContext so its analyser-fed canvases stop ' +
      'advancing. It did not happen, so any baseline captured now came off a RUNNING ' +
      'graph. Historically this failed because the AudioContext is on the AUDIO DOMAIN ' +
      "(engine.getDomain('audio').ctx), not on the root engine (engine.ctx), and the " +
      'resulting TypeError was swallowed by a `catch { /* already suspended */ }`.',
  );
}
