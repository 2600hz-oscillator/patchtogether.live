<script lang="ts">
  // OssAttribution — subdued disclaimer rendered at the bottom of cards whose
  // DSP code was ported from an MIT-licensed upstream project. Sourced from
  // AudioModuleDef.ossAttribution (see packages/web/src/lib/audio/module-registry.ts).
  //
  // `author` is optional so callers can hand us `def.ossAttribution?.author`
  // unconditionally — non-ported modules pass undefined and the line
  // disappears.
  //
  // `text` overrides the whole disclaimer for ports whose upstream is NOT
  // MIT (e.g. GPL-3.0 ports like COCOA DELAY) — the default wording is kept
  // for the existing MIT ports so their committed VRT baselines don't move.
  let { author, text }: { author?: string; text?: string } = $props();
</script>

{#if text}
  <div class="oss-attribution" data-testid="oss-attribution">{text}</div>
{:else if author}
  <div class="oss-attribution" data-testid="oss-attribution">
    Ported from MIT-licensed OSS by {author}
  </div>
{/if}

<style>
  .oss-attribution {
    /* Subtle footer — small, dimmed, monospaced so it doesn't compete with
     * the module's controls. Lives at the bottom of the card; `padding-top`
     * carves a 6px breathing room from whatever sits above (typically the
     * patch-panel port row or a control region). */
    margin-top: 8px;
    padding: 6px 14px 0;
    font-size: 0.55rem;
    line-height: 1.1;
    letter-spacing: 0.02em;
    color: var(--text-dim, #888);
    font-family: ui-monospace, monospace;
    text-align: center;
    opacity: 0.75;
  }
</style>
