<script lang="ts">
  // VirtualModule — the LEFT column of the interactive doc page: a REAL, live
  // module FACEPLATE you can hover + open patch panels on. Because it renders
  // the ACTUAL `<ModuleShell>` the rack renders, fed the same
  // `{ id, data: { node } }` shape, any face change shows up here
  // automatically — no screenshot to regenerate.
  //
  // ⚠ IT USED TO MOUNT THE LEGACY CARD (`buildNodeTypes` off the glob card-map)
  // INSIDE A ONE-NODE `<SvelteFlow>`, and BOTH halves of that had to go. The
  // card-map is being deleted with the fleet, so the doc page needed a face
  // path either way; the flow wrapper existed only to give the card's
  // `PatchPanel` a `useStore()`, and it is now actively WRONG for a face:
  // `_module-card.css` pins `.svelte-flow__node > .module-shell` to a fixed
  // `--shell-tile-w`/`--shell-tile-h` (192×180) box with `overflow: hidden`, so
  // a faceplate mounted as a flow node would be CLIPPED to a lane tile — and
  // the doc page's whole job is that every control is present to hover.
  //
  // WHAT REPLACES IT is not a new host but an EXISTING, shipped one:
  // `DockCardHost` already mounts `<ModuleShell view='drawer'>` as a plain
  // child OUTSIDE the SvelteFlow provider, and `PatchPanel` self-gates there
  // (its `useStore()` capture is guarded — see its DOCK GATE). Everything this
  // page needs survives that gate: the `patch-trigger`, the portaled drill-down
  // chrome, and the `data-port-id`/`data-direction` port rows the hover action
  // resolves against. The only thing the gate drops is the `<Handle>` stack,
  // which is a CABLE ANCHOR — and a doc page has no cables.
  //
  // WHY `view='drawer'` AND NOT `'dock-full'` OR `'lane'`, all three of which
  // render a face:
  //   * 'lane'      is the tile view: `curatedFace` applies the LANE TIER CAP
  //                 and paints the top-N ranked controls only. MEASURED on
  //                 cloudseed at this host: SIX controls under 'lane' against
  //                 FORTY-SIX under 'drawer'. Forty of the module's controls
  //                 would be undocumentable on its own documentation page.
  //   * 'dock-full' is the full faceplate but drops the jack rail entirely
  //                 (`jackRail = view !== 'dock-full'`), because DockFullView
  //                 owns a better patch surface. There is no such surface here,
  //                 so the port half of this page would simply vanish.
  //   * 'drawer'    is the full faceplate PLUS the lane `PatchPanel` — and it
  //                 is ALSO the one view `dockTabPlan` refuses to tab
  //                 (`if (view === 'drawer') return null`), so a tabbed face
  //                 renders EVERY band visibly as one scrolling column instead
  //                 of hiding 7 of its 8 pages behind a rail this page paints
  //                 no buttons for. Both properties are load-bearing here.
  //
  // CLIENT-ONLY. The shell touches `window` on mount and prerender must never
  // execute it, so the page mounts this only behind `{#if browser}` / onMount,
  // and the shell + the module registries are loaded with a DYNAMIC import in
  // onMount so the prerender server bundle never pulls the client graph. (The
  // registries in particular resolve worklet/wasm `?url` assets — the reason
  // `module-manifest.ts` parses def SOURCE instead of importing them.)
  //
  // ⚠ THE REGISTRATION BARRELS ARE IMPORTED HERE, AND NOTHING ELSE ON THIS
  // ROUTE WOULD DO IT. `ModuleShell` calls `getModuleDef`/`getVideoModuleDef`/
  // `getMetaModuleDef` but imports no barrel; on the rack it is `Canvas.svelte`
  // that does the `import '$lib/audio/modules'` side-effect registration. There
  // is no Canvas on /docs, so without these three imports every lookup returns
  // `undefined`, `curatedFace(undefined)` is never called, and the page paints
  // a faceplate FRAME WITH ZERO CONTROLS — a surface that looks plausible and
  // explains nothing. See `faceUnavailable` for the guard that makes that
  // failure name itself instead of timing out on whichever control a probe
  // happened to pick.
  //
  // SANDBOX ISOLATION (hard constraint #1 — the shell writes the GLOBAL
  // patch/ydoc):
  //   Faces mutate the singleton `patch`/`ydoc` (graph/store + mutate.ts)
  //   through the same `cardParams`/`shellParamWrite` seams the cards used —
  //   the swap does not change this constraint one bit. A naive mount would
  //   scribble on the user's real rack. So on mount we
  //   `bindRackspace(<throwaway sandbox id>)` — which creates a FRESH, LOCAL
  //   Y.Doc and is provably local-only: bindRackspace does NOT attach the
  //   Hocuspocus relay/provider (that is a SEPARATE attachProvider call made
  //   only by the rackspace page, never here), so no multiplayer room is ever
  //   opened on the doc route. On unmount we tear the binding down (restore the
  //   prior bound id, else unbind) so the sandbox can NEVER leak into a real
  //   rack.
  //
  //   We are on a docs route: no real rack is mounted in this JS context (you
  //   left it to navigate here), so rebinding is safe — the real rack's doc is
  //   only live while the rack page is mounted.

  import { onMount, onDestroy } from 'svelte';
  import {
    bindRackspace,
    unbindRackspace,
    getBoundRackspaceId,
    patch,
    ydoc,
    LOCAL_ORIGIN,
  } from '$lib/graph/store';
  import { provideEngineContext } from '$lib/audio/engine-context';
  import type { Component } from 'svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { DocIndex } from '$lib/docs/doc-index';
  import { docHover, type DocHoverState } from './use-doc-hover.svelte';

  interface DefLike {
    type: string;
    domain?: string;
    params?: { id: string; defaultValue: number | null }[];
  }

  interface Props {
    /** Module type id (e.g. 'adsr'). */
    type: string;
    /** The flat doc index — resolution target for the hover action. */
    docIndex: DocIndex;
    /** Reactive hover state (shared with the page's DocHoverPane). */
    hoverState: DocHoverState;
    /** Minimal def info (params) from the server load — prerender-safe (no
     *  live-registry import). Seeds the sandbox node's stored param values; the
     *  face itself reads the LIVE def, resolved client-side in onMount. */
    def: DefLike;
  }

  let { type, docIndex, hoverState, def }: Props = $props();

  // Provide a NULL engine: face cells read AudioParams via useEngine().get(); a
  // null engine makes readLive() a no-op (faders fall back to their stored
  // value) and the worklet/wasm factory never fires (it needs ensureEngine()).
  // So the faceplate renders + is interactive with zero audio. Action cells
  // resolve the engine through `getActiveEngine()`, which is null here too, and
  // return `false` rather than throwing — the property that made the
  // macrooscillator STRIKE button sandbox-safe on the card path.
  provideEngineContext(() => null);

  // ---- Sandbox bind lifecycle ------------------------------------------------
  const DEMO_ID = 'demo';
  // svelte-ignore state_referenced_locally -- SANDBOX_ID is consumed once, inside onMount, and
  // /docs/modules/[id] wraps this component in {#key mod.type}, so a different module type
  // REMOUNTS rather than mutating this instance's `type`.
  const SANDBOX_ID = `__docs-sandbox__:${type}`;
  let prevBoundId: string | null = null;

  function seedSandboxNode() {
    // Defaults straight off the def's params (prerender-safe shape).
    const params: Record<string, number> = {};
    for (const p of def.params ?? []) {
      if (p.defaultValue !== null && p.defaultValue !== undefined) params[p.id] = p.defaultValue;
    }
    const node: ModuleNode = {
      id: DEMO_ID,
      type: type as ModuleNode['type'],
      domain: (def.domain ?? 'audio') as ModuleNode['domain'],
      position: { x: 0, y: 0 },
      params,
      data: {},
    };
    // Write into the SANDBOX patch (now the bound singleton) in one transaction.
    ydoc.transact(() => {
      patch.nodes[DEMO_ID] = node;
    }, LOCAL_ORIGIN);
  }

  // The live node the shell reads from `data.node` — re-read from the sandbox
  // store so param cells that read `patch.nodes[id]` stay consistent.
  let demoNode = $state<ModuleNode | null>(null);

  // ---- The shell (dynamic, client-only) -------------------------------------
  let Shell = $state<Component | null>(null);
  /** The live def resolved AND carrying a `face` declaration. False is a
   *  REFUSAL, not a loading state: without it the shell paints a controlless
   *  frame (see the registration-barrel note in the header). */
  let faceUnavailable = $state(false);
  // The FACEPLATE's own readiness: the shell is mounted and has a real box.
  // `virtual-module-face` existing only means the dynamic import resolved —
  // the historical CI failure here (run 33567352895) was a spec that waited on
  // the host and then asserted a control that resolved for ten straight
  // seconds without ever becoming visible. Surfaced as `data-face-ready` so a
  // regression fails THERE, naming the faceplate, instead of downstream on
  // whichever control the probe happened to pick.
  let facePainted = $state(false);
  let hostEl: HTMLDivElement | null = $state(null);

  onMount(() => {
    let cancelled = false;
    (async () => {
      // Capture + swap to the throwaway sandbox BEFORE the shell mounts.
      prevBoundId = getBoundRackspaceId();
      bindRackspace(SANDBOX_ID);
      seedSandboxNode();
      demoNode = patch.nodes[DEMO_ID] as ModuleNode;

      // Dynamic imports keep all of this out of the prerender server bundle.
      //
      // ⚠ THE BARRELS GO FIRST, AND THE ORDER IS A CORRECTNESS REQUIREMENT,
      // NOT A PREFERENCE. These three imports are SIDE-EFFECT ONLY — they are
      // what POPULATES the registries the lookups below (and the shell) read.
      // But `audio/modules/index.ts` also runs `registerAudioModules()` at
      // module scope, and that walks `Object.entries()` over the namespace of
      // EVERY globbed module file. Reach the barrel while one of those files
      // is still initialising and the walk reads a binding in its temporal
      // dead zone.
      //
      // That is not hypothetical: importing `ModuleShell` first threw
      // `ReferenceError: CLOCKED_RUNNER_DEFAULT_DIVISION is not defined` from
      // `collectAudioDefs`, because the shell's own import closure
      // (ModuleShell → shell-cells → clocked-runner-cell-actions →
      // audio/modules/clocked-runner → livecode/runtime) re-enters the barrel
      // partway through `clocked-runner.ts`. `Canvas.svelte` is safe from this
      // only because its `import '$lib/audio/modules'` sits ~200 lines ABOVE
      // its `import ModuleShell`, so ES source order fully evaluates the
      // barrel first. Nothing in the repo states that dependency — this route
      // is the second entry point, and it has to honour it explicitly.
      await Promise.all([
        import('$lib/audio/modules'),
        import('$lib/video/modules'),
        import('$lib/meta/modules'),
      ]);
      if (cancelled) return;
      const [ModuleShellModule, audioRegistry, videoRegistry, metaRegistry] = await Promise.all([
        import('$lib/ui/modules/ModuleShell.svelte'),
        import('$lib/audio/module-registry'),
        import('$lib/video/module-registry'),
        import('$lib/meta/module-registry'),
      ]);
      if (cancelled) return;

      const liveDef =
        audioRegistry.getModuleDef(type) ??
        videoRegistry.getVideoModuleDef(type) ??
        metaRegistry.getMetaModuleDef(type);
      // A def with no `face` makes `curatedFace` return null and the shell
      // render zero cells — indistinguishable, on the page, from a face whose
      // controls failed to paint. Refuse explicitly instead.
      if (!liveDef || !(liveDef as { face?: unknown }).face) {
        faceUnavailable = true;
        return;
      }
      Shell = ModuleShellModule.default as unknown as Component;
    })().catch((e) => {
      // ⚠ A REJECTION HERE MUST BECOME THE REFUSAL, NOT SILENCE. Uncaught, the
      // component simply stays on `virtual-module-loading` forever and the only
      // evidence is a `pageerror` — which is exactly what a chunk that fails to
      // fetch (seen live: `Failed to fetch dynamically imported module` when the
      // dev server restarted mid-navigation) produced: a page that says
      // "loading live module…" indefinitely, and a waiter that burns its whole
      // timeout before failing on some unrelated control. Routing it to the
      // refusal arm makes the failure immediate and named on the page; the
      // console carries the cause, since the refusal text is for a reader.
      if (cancelled) return;
      console.error('[VirtualModule] live faceplate unavailable', e);
      faceUnavailable = true;
    });

    return () => {
      cancelled = true;
    };
  });

  // FACEPLATE PAINTED — observable state, not a timer and not a frame budget.
  // ResizeObserver fires once on observe with the current box, so an
  // already-laid-out shell flips this on the first callback and one that starts
  // at 0×0 (fonts, a late extension chunk) flips it when it grows. If the shell
  // element is somehow absent the attribute stays 'false', which is the
  // observable a waiter should fail on.
  $effect(() => {
    const host = hostEl;
    if (!host || !Shell) return;
    const shell = host.querySelector<HTMLElement>('[data-testid="module-shell"]');
    if (!shell) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) facePainted = true;
    });
    ro.observe(shell);
    return () => ro.disconnect();
  });

  onDestroy(() => {
    // Tear the sandbox down so it can NEVER leak into a real rack. Remove the
    // demo node, then restore the prior binding (or unbind). On a docs route no
    // real rack doc is live in this context, so rebinding is a safe reset.
    try {
      if (getBoundRackspaceId() === SANDBOX_ID) {
        ydoc.transact(() => {
          delete patch.nodes[DEMO_ID];
        }, LOCAL_ORIGIN);
        if (prevBoundId && prevBoundId !== SANDBOX_ID) bindRackspace(prevBoundId);
        else unbindRackspace();
      }
    } catch {
      /* best-effort teardown */
    }
  });
</script>

<!--
  The hover action lives on the root so it captures hovers on BOTH the faceplate
  controls AND the portaled patch-panel chrome (the chrome portals to <body>, so
  the listener is delegated in CAPTURE phase from the document — but the chrome
  carries its own data-port-id rows, and the action's onOver is bound on this
  node in capture; the portaled rows bubble up via the body, so we also resolve
  port rows by their attributes regardless of DOM ancestry). To be robust to the
  portal, the page also wires a document-level fallback (see +page.svelte).
-->
<div
  class="virtual-module"
  data-testid="virtual-module"
  data-module-type={type}
  use:docHover={{ docIndex, state: hoverState }}
>
  {#if Shell && demoNode}
    {@const ShellC = Shell}
    {@const node = demoNode}
    <div
      class="face-host"
      data-testid="virtual-module-face"
      data-face-ready={facePainted ? 'true' : 'false'}
      bind:this={hostEl}
    >
      <!-- THE FACEPLATE'S BOX, and why it needs no explicit one. `.rl-tile` is
           `width:100%; height:100%`, and a percentage resolves as `auto` for
           its parent's intrinsic sizing — so a `width: max-content` wrapper
           takes the faceplate's own natural width and the faceplate fills it.
           Same construction, and the same reasoning, as `.dock-natural-sized`
           in DockCardHost; the class is local rather than reused because a
           docs surface should not inherit a dock rail's sizing rules by
           name. The 150px `.rl-tile` lane floor does not apply: `dock-full`
           (which `isFaceplateView` stamps for the drawer view too) sets
           `min-width: 0`. -->
      <div class="face-natural">
        <ShellC id={DEMO_ID} data={{ node, view: 'drawer' }} />
      </div>
    </div>
  {:else if faceUnavailable}
    <div class="vm-unavailable" data-testid="virtual-module-unavailable">
      no live faceplate for <code>{type}</code>
    </div>
  {:else}
    <div class="vm-loading" data-testid="virtual-module-loading">loading live module…</div>
  {/if}
</div>

<style>
  .virtual-module {
    position: relative;
  }
  .face-host {
    /* Dark slate inspector backdrop — the faceplate is drawn for a dock pane
       over dark chrome, and a bare docs background reads as a hole around it. */
    --vm-backdrop: #2a2d34;
    position: relative;
    /* The drawer view is DESIGNED as "the one scrolling column its host can
       actually scroll" (dock-tabs-model): a tabbed face renders every band at
       once here, so the tall ones need somewhere to scroll. Bounded rather
       than free-growing so the hover pane beside it stays on screen while you
       read down the faceplate — the pane is the other half of this surface.
       The portaled patch chrome is NOT clipped by this: it renders to <body>. */
    min-height: 220px;
    max-height: 70vh;
    overflow: auto;
    padding: 10px;
    border: 1px solid var(--doc-border-dim, #062b32);
    border-radius: 6px;
    background: var(--vm-backdrop);
  }
  .face-natural {
    position: relative;
    width: max-content;
  }
  .vm-loading,
  .vm-unavailable {
    height: 220px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    color: var(--doc-fg-dim, #6e7a82);
    border: 1px dashed var(--doc-border-dim, #062b32);
    border-radius: 6px;
    font-size: 0.85rem;
  }
</style>
