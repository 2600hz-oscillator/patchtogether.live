<script lang="ts">
  // FeedbackBox.svelte
  //
  // A small floating modal triggered by a "Feedback" button. Lets an authed
  // user pick "Suggestion" or "Bug" (required), type up to 512 chars, and
  // optionally attach a snapshot of the current patch. Submissions POST to
  // /api/feedback. UI only — server-side validation is the source of truth.
  //
  // Props:
  //   rackId        — current rackspace id, or null when on dashboard
  //   getPatchJson  — optional zero-arg callback that returns a serializable
  //                   snapshot of the current patch. Absent ⇒ no "include
  //                   current patch" checkbox is shown.

  const MAX_LENGTH = 512;

  interface Props {
    rackId?: string | null;
    getPatchJson?: () => unknown;
  }

  let { rackId = null, getPatchJson }: Props = $props();

  let open = $state(false);
  let kind: 'suggestion' | 'bug' | null = $state(null);
  let message = $state('');
  let includePatch = $state(true);
  let submitting = $state(false);
  let errorMsg: string | null = $state(null);
  let success = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  let charsLeft = $derived(MAX_LENGTH - message.length);
  let canSubmit = $derived(
    !submitting && kind !== null && message.trim().length > 0 && message.length <= MAX_LENGTH,
  );

  function openBox() {
    open = true;
    success = false;
    errorMsg = null;
    // Defer focus until the textarea is in the DOM.
    queueMicrotask(() => textareaEl?.focus());
  }

  function closeBox() {
    open = false;
    // Reset form so re-opening doesn't reuse stale state.
    kind = null;
    message = '';
    includePatch = true;
    submitting = false;
    errorMsg = null;
    success = false;
  }

  async function submit() {
    if (!canSubmit || kind === null) return;
    submitting = true;
    errorMsg = null;
    try {
      const body: {
        kind: 'suggestion' | 'bug';
        message: string;
        rackId?: string | null;
        patchJson?: unknown;
      } = { kind, message: message.trim() };
      if (rackId) body.rackId = rackId;
      if (includePatch && getPatchJson) {
        try {
          body.patchJson = getPatchJson();
        } catch (e) {
          // Non-fatal: submit without the snapshot rather than block the user.
          console.warn('[feedback] getPatchJson threw; submitting without snapshot', e);
        }
      }
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        errorMsg = data.message ?? `Submit failed: ${res.status}`;
        return;
      }
      success = true;
      // Auto-close after a beat so the user sees the confirmation.
      setTimeout(() => {
        if (success) closeBox();
      }, 1000);
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      submitting = false;
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      closeBox();
    }
  }
</script>

<button
  class="feedback-trigger"
  type="button"
  onclick={openBox}
  data-testid="feedback-button"
  title="Send feedback"
>
  Feedback
</button>

<!-- svelte:window must live at component top level (not inside an {#if}).
     We make the listener a no-op when the modal is closed to keep the
     handler logic simple. -->
<svelte:window onkeydown={(ev) => open && onKeydown(ev)} />

{#if open}
  <!-- Backdrop catches clicks outside the panel. role=dialog announces to
       screen readers. -->
  <div
    class="feedback-backdrop"
    role="presentation"
    onclick={closeBox}
    onkeydown={onKeydown}
    data-testid="feedback-backdrop"
  >
    <div
      class="feedback-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-heading"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      data-testid="feedback-panel"
    >
      <h2 id="feedback-heading">Send feedback</h2>

      <fieldset class="kind-group">
        <legend>What is this?</legend>
        <label class:active={kind === 'suggestion'}>
          <input
            type="radio"
            name="feedback-kind"
            value="suggestion"
            bind:group={kind}
            data-testid="feedback-kind-suggestion"
          />
          Suggestion
        </label>
        <label class:active={kind === 'bug'}>
          <input
            type="radio"
            name="feedback-kind"
            value="bug"
            bind:group={kind}
            data-testid="feedback-kind-bug"
          />
          Bug
        </label>
      </fieldset>

      <label class="message-label">
        <span>Message</span>
        <textarea
          bind:this={textareaEl}
          bind:value={message}
          maxlength={MAX_LENGTH}
          rows={5}
          placeholder={kind === 'bug'
            ? "What went wrong? What did you expect to happen?"
            : kind === 'suggestion'
            ? "What would make this better?"
            : "Pick a kind above, then describe…"}
          data-testid="feedback-message"
        ></textarea>
        <span class="char-counter" class:warn={charsLeft < 32} data-testid="feedback-counter">
          {charsLeft}
        </span>
      </label>

      {#if getPatchJson}
        <label class="include-patch">
          <input
            type="checkbox"
            bind:checked={includePatch}
            data-testid="feedback-include-patch"
          />
          Include current patch ({rackId ? 'helps reproduce bugs' : 'no rack — ignored'})
        </label>
      {/if}

      {#if errorMsg}
        <p class="error" data-testid="feedback-error">{errorMsg}</p>
      {/if}
      {#if success}
        <p class="success" data-testid="feedback-success">Thanks!</p>
      {/if}

      <div class="actions">
        <button
          type="button"
          class="cancel"
          onclick={closeBox}
          disabled={submitting}
          data-testid="feedback-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          class="submit"
          onclick={submit}
          disabled={!canSubmit}
          data-testid="feedback-submit"
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .feedback-trigger {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent-dim);
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.75rem;
    transition: box-shadow 80ms ease-out, border-color 80ms ease-out;
  }
  .feedback-trigger:hover {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }

  .feedback-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9000;
  }

  .feedback-panel {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--accent-dim);
    border-radius: 4px;
    box-shadow: 0 0 24px var(--accent-glow);
    padding: 20px 22px;
    width: min(440px, 92vw);
    max-height: 85vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .feedback-panel h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
    color: var(--accent);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  fieldset.kind-group {
    border: 1px dashed #2a2f3a;
    border-radius: 3px;
    padding: 8px 12px;
    margin: 0;
    display: flex;
    gap: 16px;
  }
  fieldset.kind-group legend {
    padding: 0 6px;
    font-size: 0.7rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  fieldset.kind-group label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 0.85rem;
    color: var(--text-dim);
    transition: color 80ms ease-out;
  }
  fieldset.kind-group label.active {
    color: var(--accent);
  }
  fieldset.kind-group input[type='radio'] {
    accent-color: var(--accent);
  }

  .message-label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    position: relative;
  }
  .message-label > span {
    font-size: 0.7rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .message-label textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.85rem;
    resize: vertical;
    min-height: 80px;
    transition: border-color 80ms ease-out, box-shadow 80ms ease-out;
  }
  .message-label textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }
  .char-counter {
    align-self: flex-end;
    font-family: ui-monospace, monospace;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .char-counter.warn {
    color: var(--cable-gate);
  }

  .include-patch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.78rem;
    color: var(--text-dim);
    cursor: pointer;
  }
  .include-patch input[type='checkbox'] {
    accent-color: var(--accent);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .actions button {
    border: 1px solid #404652;
    background: #2a2f3a;
    color: var(--text);
    padding: 6px 14px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
    transition: background 80ms ease-out, border-color 80ms ease-out;
  }
  .actions button:hover:not(:disabled) {
    background: #353a47;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .actions .submit {
    border-color: var(--accent-dim);
    color: var(--accent);
    background: transparent;
  }
  .actions .submit:hover:not(:disabled) {
    border-color: var(--accent);
    background: rgba(0, 240, 255, 0.06);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }

  .error {
    margin: 0;
    color: var(--cable-gate);
    font-size: 0.8rem;
  }
  .success {
    margin: 0;
    color: var(--cable-cv);
    font-size: 0.8rem;
  }
</style>
