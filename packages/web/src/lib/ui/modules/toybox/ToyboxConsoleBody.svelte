<script lang="ts">
  // ToyboxConsoleBody — TOYBOX's `fullViewBody`, the surface promotion leaves
  // the module with.
  //
  // ⚠ IT IS A HOST, NOT A SECOND CONSOLE. It renders `./ToyboxConsole.svelte`
  // with `layout="face"` and owns exactly two things of its own: the SCREEN
  // switch, and the `node.data.previewCollapsed` state behind it. Every control
  // TOYBOX has comes from the console, which the legacy card mounts too — see
  // that file's header for why a copy was refused.
  //
  // WHY A BODY AND NOT CELLS. `toyboxDef.params` is `[]` — the module declares
  // ZERO ParamDefs — so `face.order` is empty and the faceplate has no bands for
  // an extension to sit above. There is nothing for a `ParamCellKind` to bind
  // to, and the things a player actually operates are (layer × kind)-scoped or
  // (graph-node)-scoped: a roster that changes under their hands as they add op
  // nodes and switch layer kinds, which no static `order` can name. `fullViewBody`
  // is the wired slot for a module that brings its own whole surface.
  //
  // ⚠ AND WITHOUT IT THE MODULE WOULD BE UNREACHABLE, not merely reduced.
  // toybox is in none of `DOM_SOURCE_LANE_TYPES` / `CARD_PRODUCER_LANE_TYPES` /
  // `HEADLESS_MOUNT_LANE_TYPES`, so promotion stops `ToyboxCard.svelte` being
  // mounted ANYWHERE — there is no headless host to fall back on. A missing body
  // would ship a four-layer compositor with no way to choose a layer, a shader,
  // an op or a route.
  //
  // ⚠ THE SCREEN SWITCH IS NOT A PAUSE. `previewCollapsed` gates the BLIT — a GL
  // readback into a surface nobody can see — and nothing else. The console goes
  // on renewing this node's watch mark every frame while the screen is off (its
  // `renewWatchMark`), because TOYBOX's combine roster carries FEEDBACK,
  // FRAMEDELAY, EXQUISITE and DATAMOSH, all of which accumulate history between
  // frames, and `out` is a real cable other modules sample. Letting the mark
  // lapse would freeze what every downstream consumer sees and bring the picture
  // back black or stale when the screen came on again.

  import { patch } from '$lib/graph/store';
  import { mutateNode } from '$lib/graph/mutate';
  import ToyboxConsole from './ToyboxConsole.svelte';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  // ── SCREEN ON/OFF (the fleet ruling, #1928) ────────────────────────────────
  //
  // ⚠ STATE LIVES ON THE NODE, NOT IN THIS COMPONENT. A `$state` here dies with
  // the component, and this component unmounts on a dock collapse or an LRU
  // eviction — the card-unmount-kills-node-lifetime-state class (#1531 / #1574
  // / #1583). `node.data` survives a remount, survives reload, and syncs to
  // collaborators. It is one boolean per CLICK, never per frame, so it is
  // nowhere near the Y.Doc write-storm rule (which is about per-frame CV).
  //
  // Absent ⇒ false ⇒ the screen is ON, so an existing rack opens unchanged.
  //
  // The recorded objection to a Y.Doc-synced collapse — a peer can switch off
  // the only picture for everyone — is real and SELF-UNDOING here for the same
  // reason it was on painter: the button renders OUTSIDE the collapse, so any
  // peer restores it with one click. That is why toybox takes the fleet switch
  // instead of a `NO_SCREEN_SWITCH` exemption.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );

  function toggleScreen(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      live.data.previewCollapsed = next;
    });
  }
</script>

<div class="tb-body" data-testid="toybox-face-body" data-node-id={nodeId}>
  <!-- ⚠ THE SWITCH RENDERS OUTSIDE THE COLLAPSE, always — a control that hid
       with the thing it controls could not turn it back on. -->
  <div class="tb-screen-bar">
    <button
      type="button"
      class="tb-screen-btn"
      class:on={!previewCollapsed}
      data-testid="toybox-face-screen-toggle"
      aria-pressed={!previewCollapsed}
      onclick={toggleScreen}
      title={previewCollapsed
        ? 'Show the composite. The engine never stopped — the layers, the combine graph and every history op kept running while it was off.'
        : 'Hide the composite and reclaim the space. The engine keeps rendering: OUT, the feedback nest and every downstream module are unaffected.'}
    >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>
  </div>

  <ToyboxConsole {nodeId} layout="face" screenOn={!previewCollapsed} />
</div>

<style>
  .tb-body {
    display: flex;
    flex-direction: column;
    color: var(--text);
  }
  /* The switch sits above the picture rather than over it: TOYBOX's screen is
   * also a POINTER SURFACE (the projective-mapping corner drag lives on that
   * canvas), so a corner overlay would sit on top of a gesture target. */
  .tb-screen-bar {
    display: flex;
    justify-content: flex-end;
    padding: 6px 16px 0;
  }
  .tb-screen-btn {
    appearance: none;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-dim);
    cursor: pointer;
    font: inherit;
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    padding: 2px 8px;
  }
  .tb-screen-btn.on {
    color: var(--text);
    border-color: var(--cable-video);
  }
  .tb-screen-btn:hover { color: var(--text); }
</style>
