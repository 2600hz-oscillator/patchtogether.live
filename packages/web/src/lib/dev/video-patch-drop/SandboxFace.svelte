<script lang="ts">
  // ⛔ DEV SANDBOX — a stand-in faceplate for the drop gesture.
  //
  // ⚠ THIS IS NOT A REAL CARD, AND THAT IS DELIBERATE. The shipped module
  // cards resolve an engine node, an audio graph and a patch store; mounting
  // them here would make the sandbox a second rack, which is exactly what the
  // scope discipline on this PR forbids. What has to be REAL for the gesture to
  // be reviewable is the DRAG (xyflow's own, unmodified), the GEOMETRY (flow-
  // space rects), and the DEF the modal reads. All three are.
  //
  // What is fake: the pixels. The port dots below are drawn from the def rather
  // than by PatchPanel, so this card cannot tell you what a real one looks like.
  import { Handle, Position } from '@xyflow/svelte';
  import type { DropDefLike } from './drop-plan';

  interface Props {
    data: { def: DropDefLike; label: string; patchedIn: number; patchedOut: number };
  }
  let { data }: Props = $props();

  let ins = $derived([...(data.def.inputs ?? [])]);
  let outs = $derived([...(data.def.outputs ?? [])]);
  /** Dots are capped for LAYOUT only, and the remainder is stated — the same
   *  rule the modal follows. A silent truncation here would re-create, in the
   *  sandbox chrome, the exact problem the modal exists to fix. */
  const DOT_CAP = 10;
</script>

<div class="face" data-testid="sandbox-face" data-node-label={data.label}>
  <Handle type="target" position={Position.Left} style="opacity:0" />
  <header class="face-head">
    <span class="face-name">{data.label}</span>
    {#if data.patchedIn + data.patchedOut > 0}
      <span class="face-pat" data-testid="sandbox-face-patched"
        >{data.patchedIn + data.patchedOut}</span
      >
    {/if}
  </header>

  <div class="face-body">
    <div class="face-col">
      <span class="face-role">in</span>
      <div class="dots">
        {#each ins.slice(0, DOT_CAP) as p (p.id)}
          <span class="dot" data-cable={p.type} title={`${p.id} · ${p.type}`}></span>
        {/each}
      </div>
      <span class="face-n">{ins.length}{ins.length > DOT_CAP ? ` (${DOT_CAP} shown)` : ''}</span>
    </div>
    <div class="face-col">
      <span class="face-role">out</span>
      <div class="dots">
        {#each outs.slice(0, DOT_CAP) as p (p.id)}
          <span class="dot" data-cable={p.type} title={`${p.id} · ${p.type}`}></span>
        {/each}
      </div>
      <span class="face-n">{outs.length}{outs.length > DOT_CAP ? ` (${DOT_CAP} shown)` : ''}</span>
    </div>
  </div>
  <Handle type="source" position={Position.Right} style="opacity:0" />
</div>

<style>
  .face {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    border: 1px solid #39414f;
    border-radius: 6px;
    background: #1b1f27;
    color: #e6e9ef;
    font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden;
    user-select: none;
  }
  :global(.svelte-flow__node.selected) .face {
    border-color: #6f9fd0;
  }
  .face-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid #2b3039;
    background: #222732;
    font-size: 11.5px;
    letter-spacing: 0.02em;
  }
  .face-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .face-pat {
    margin-left: auto;
    padding: 0 5px;
    border: 1px solid #4a7a5c;
    border-radius: 8px;
    color: #6fd08c;
    font-size: 9px;
  }
  .face-body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    flex: 1;
    padding: 7px 8px;
  }
  .face-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .face-role {
    font-size: 8.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #79818f;
  }
  .dots {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    align-content: flex-start;
    flex: 1;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4b5262;
  }
  .dot[data-cable='video'] {
    background: #c77dff;
  }
  .dot[data-cable='mono-video'] {
    background: #9ad6e8;
  }
  .dot[data-cable='image'] {
    background: #ffb570;
  }
  .dot[data-cable='keys'] {
    background: #ff9dd4;
  }
  .face-n {
    font-size: 8.5px;
    color: #656d7c;
  }
</style>
