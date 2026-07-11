<script lang="ts">
  // WorkflowLeftbar — the WORKFLOW-mode left rail.
  //
  // EMPTY SCAFFOLD by design: the owner has not yet specified the left
  // toolbar's contents (open question Q1 in
  // .myrobots/plans/workflow-mode-2026-07-10.md). P1 ships the styled
  // rail so the workflow shell's geometry is final; contents land once
  // Q1 is answered. Rendered as an overlay on the canvas's left edge —
  // a future DOCK ZONE ('left', typed in $lib/ui/dock/dock.ts) candidate.
</script>

<nav class="workflow-leftbar" data-testid="workflow-leftbar" aria-label="Workflow tools (empty scaffold)">
  <span class="rail-hint" title="Left toolbar — contents pending (owner Q1)">···</span>
</nav>

<style>
  .workflow-leftbar {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 44px;
    z-index: 15;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 12px;
    background: #12151b;
    border-right: 1px solid #232833;
  }
  .rail-hint {
    color: var(--text-dim);
    opacity: 0.5;
    font-size: 0.9rem;
    letter-spacing: 2px;
    writing-mode: vertical-rl;
    user-select: none;
  }
</style>
