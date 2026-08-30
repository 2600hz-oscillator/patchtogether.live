<script lang="ts">
  // GatemaidenCard — single-input gate↔trigger converter.
  // One IN; a GATE out (held square, min width Len) + a TRIG out (short pulse
  // per rising edge). ▷ marks the trigger port, ▭ the gate ports.

  import type { NodeProps } from '@xyflow/svelte';
  import NeonFader from '$lib/ui/controls/NeonFader.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { gatemaidenDef } from '$lib/audio/modules/gatemaiden';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import { cardParams, paramSpec, portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const { paramVal, set, live } = cardParams(gatemaidenDef, () => id, () => node);

  /** THE ONE COPY of every number this card paints — bound, never re-typed.
   *  Paid when the module was faced: from that point the dock renders LEN
   *  straight off the `ParamDef`, so a literal here would give one control two
   *  travels depending on which surface you reached it through. */
  const P = { gateLen: paramSpec(gatemaidenDef, 'gateLen') };

  // ▷ = trigger (short pulse), ▭ = gate (held level) — the trigger/gate glyphs.
  const inputs = portsFromDef(gatemaidenDef.inputs);
  const outputs = portsFromDef(gatemaidenDef.outputs, { gate: '▭ GATE', trig: '▷ TRIG' });

  // ⚠ THE NAMES COME FROM THE DEF (`trigShape.options`), NOT FROM A LITERAL
  // HERE. They used to be `const shapeLabels = ['△ TRI', '▭ SQR']`, which made
  // this card the ONLY place the two states were named — so the faceplate
  // painted an anonymous switch (#2025). The leading shape glyph stays as
  // card-local decoration, in the same visual language as the ▭/▷ port labels
  // above; the def's roster is deliberately ASCII so the faceplate does not
  // depend on a glyph the pinned VRT font subsets do not carry.
  const shapeOptions = paramSpec(gatemaidenDef, 'trigShape').options ?? [];
  const SHAPE_GLYPHS = ['△', '▭'] as const;

  let shapeIndex = $derived((paramVal('trigShape') | 0) % shapeOptions.length);
  let shapeLabel = $derived(`${SHAPE_GLYPHS[shapeIndex]} ${shapeOptions[shapeIndex]?.label ?? ''}`);

  // Writes through the TRACKED param path (undoable + synced to collaborators).
  // This was a raw `t.params.trigShape = …` store poke and carried a `debt`
  // entry in `raw-write-ledger.ts`; the entry is deleted with the write, since
  // the ledger is anchored to the artifact rather than to the module's status.
  function cycleShape() {
    set('trigShape')(shapeIndex >= 1 ? 0 : 1);
  }
</script>

<div class="mod-card gatemaiden-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <ModuleTitle {id} {data} defaultLabel="gatemaiden" />

  <PatchPanel nodeId={id} {inputs} {outputs} panelWidth={180}>
    <div class="body">
      <div class="len">
        <NeonFader
          value={paramVal('gateLen')}
          min={P.gateLen.min} max={P.gateLen.max} defaultValue={P.gateLen.defaultValue}
          label={P.gateLen.label}
          curve="log"
          onchange={set('gateLen')} moduleId={id} paramId="gateLen"
          readLive={live('gateLen')}
        />
      </div>
      <button class="modebtn" onclick={cycleShape} data-testid="gatemaiden-shape">{shapeLabel}</button>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 200px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    /* Rack-compaction (#759): tightened 18/14 → 10/9 to fit the 1u tier. */
    padding-top: 10px;
    padding-bottom: 9px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }
  .body {
    /* Rack-compaction (#759): tightened padding + gap to fit 1u. */
    padding: 2px 10px 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .len { width: 60px; }
  .modebtn {
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    padding: 5px 10px;
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .modebtn:hover { border-color: var(--accent-dim); color: var(--text); }
</style>
