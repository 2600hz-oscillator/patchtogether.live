<script lang="ts">
  // Pre-flight (Stage-1) PLACEHOLDER. It proves the two-stage launch swap and
  // lets a first-run boot reach the rack; the real per-slot setup panel is Part 2.
  import { goto } from '$app/navigation';
  import { nativeAvailable } from '$lib/platform/native';

  interface PtNativeLike {
    command?: (op: string, payload?: unknown) => Promise<unknown>;
  }

  let entering = $state(false);

  async function enterRack(): Promise<void> {
    if (entering) return;
    entering = true;
    // Under the shell the MAIN process owns the /preflight→/rack swap (it also
    // records that the pre-flight ran, so the next launch boots straight to the
    // rack). In a plain browser there is no two-stage launch — just navigate.
    const nat = (globalThis as unknown as { ptNative?: PtNativeLike }).ptNative;
    if (nativeAvailable() && nat?.command) {
      try {
        await nat.command('preflight.done');
        return; // the shell is loading /rack; this document is going away
      } catch {
        /* fall through to a client navigation if the bridge call fails */
      }
    }
    await goto('/rack');
  }
</script>

<svelte:head><title>rig setup · patchtogether</title></svelte:head>

<main class="preflight">
  <div class="card">
    <h1>rig setup</h1>
    <p class="lede">
      This is where you'll connect your rig before the rack opens — screens,
      cameras, ES-9, Push, Launchpad and PTZ — and those connections will stay
      put no matter what you do in the rack.
    </p>
    <p class="note">
      The full setup panel is landing next. The persistent-rig layer underneath
      it is live now, so what you bind survives a File→New, a reload, and a
      relaunch.
    </p>
    <button class="enter" onclick={enterRack} disabled={entering}>
      {entering ? 'opening rack…' : 'enter rack'}
    </button>
  </div>
</main>

<style>
  .preflight {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 2rem;
    background: #0d0f14;
    color: #e7e9ee;
    font: 14px/1.5 system-ui, -apple-system, sans-serif;
  }
  .card {
    max-width: 30rem;
    background: #161a22;
    border: 1px solid #262c38;
    border-radius: 12px;
    padding: 2rem 2.25rem;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
  }
  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.5rem;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .lede {
    margin: 0 0 0.75rem;
    color: #c3c8d2;
  }
  .note {
    margin: 0 0 1.5rem;
    color: #8b93a1;
    font-size: 13px;
  }
  .enter {
    appearance: none;
    border: 0;
    border-radius: 8px;
    padding: 0.7rem 1.4rem;
    font: inherit;
    font-weight: 600;
    color: #0d0f14;
    background: #7c5cff;
    cursor: pointer;
  }
  .enter:hover:not(:disabled) {
    background: #8f72ff;
  }
  .enter:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
