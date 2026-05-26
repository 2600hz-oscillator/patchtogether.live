<script lang="ts">
  // DOOM — multiplayer operator reference (slice 7 of the true-4-player plan).
  //
  // Operator-style, no marketing copy: how to start a game, how others join,
  // late-join behavior, player colors, and the keymap. The slot→color mapping
  // is the single source of truth from $lib/doom/doom-player-identity so the
  // table never drifts from what the card renders.

  import { DOOM_SLOT_COLORS } from '$lib/doom/doom-player-identity';

  // Keymap (issue #280). Arrows move, Ctrl fires, Space uses/opens doors.
  const KEYMAP: { keys: string; action: string }[] = [
    { keys: 'Arrow Up / Down', action: 'Move forward / backward' },
    { keys: 'Arrow Left / Right', action: 'Turn left / right' },
    { keys: 'Ctrl', action: 'Fire' },
    { keys: 'Space', action: 'Use / open doors / flip switches' },
    { keys: '1 – 7', action: 'Select weapon' },
  ];
</script>

<svelte:head>
  <title>DOOM multiplayer · modules · patchtogether.live</title>
  <meta
    name="description"
    content="Operator reference for DOOM 4-player co-op: starting a game, joining, late-join, player colors, and controls."
  />
</svelte:head>

<section class="hero">
  <h1>DOOM — multiplayer</h1>
  <div class="sub">
    <code>doom</code> · video · up to 4 players, co-op netgame
  </div>
</section>

<p>
  The DOOM module runs the shareware game in WebAssembly, one independent
  instance per peer. Only the <strong>rack owner</strong> can add the DOOM
  widget — it's a host-driven module. The owner starts a multiplayer game; every
  other person in the rackspace then sees the same card and can join it with one
  click. Each peer renders its own first-person view, and every player's marine
  appears in every other peer's world. Up to <strong>4 players</strong> (one
  shared DOOM card, one runtime per peer).
</p>

<h2>Owner-only widget</h2>
<p>
  DOOM can only be <strong>added by the rack owner</strong>. Guests won't find it
  in the add-module palette — there is exactly one shared DOOM card per rack, and
  the owner is its host (Player 1). This keeps the flow simple: the owner sets up
  the game, everyone else joins it.
</p>

<h2>Start a multiplayer game (owner)</h2>
<p>The owner is the host / <strong>arbiter</strong> (Player 1) and drives the
game start:</p>
<ol class="steps">
  <li>Add a <code>DOOM</code> module to the canvas and click the card to load
    the game (the shareware WAD downloads once, then caches locally).</li>
  <li>Click <strong>Host Multiplayer</strong>, then open <strong>New Game</strong>
    and pick mode (co-op), skill, episode, and map.</li>
  <li>Hit <strong>Launch</strong>. You enter the level, and the game is now
    <strong>live</strong> — that's the single gate. From this point, any guest's
    Join is always valid.</li>
</ol>
<p>
  Only the owner sees the New Game dialog and the start choice (Single Player /
  Host Multiplayer). Single-player is owner-only too: a lone owner plays a normal
  single-player game with no netcode. Mode, WAD, and skill are locked while a
  level runs — changing them means ending the current game.
</p>

<h2>Join (one-click hot-join)</h2>
<p>
  Guests see the DOOM card with a <strong>Join</strong> button. It stays
  <strong>disabled</strong> — reading "Waiting for host to start a multiplayer
  game…" — until the owner is actually running a live multiplayer game. The
  moment the owner is in-level, your Join button enables and a
  <strong>single click drops you straight into the running level</strong> with
  your own first-person view. No second host action is needed.
</p>
<p>The arbiter assigns you the next free player slot (Player 1 → 4, in order).
You don't pick a slot — the arbiter assigns it deterministically so two
simultaneous joins can't collide.</p>

<h2>How the hot-join works</h2>
<p>
  DOOM has no <em>true</em> mid-level join: the original netgame fixes the
  player set when the level starts (<code>G_InitNew</code> spawns one marine per
  active slot, and the lockstep tic stream assumes a constant
  <code>playeringame[]</code>). So spawning a new marine into an
  already-running level mid-tic isn't possible.
</p>
<p>
  We get the same outcome the pragmatic way: when you click the enabled
  <strong>Join</strong>, the arbiter seats you as an active player and
  <strong>automatically re-launches the current map</strong> (same skill,
  episode, and map — only the player count grows). Every peer reloads the level
  via <code>G_InitNew</code>, so you drop into the <em>current</em> map at your
  coop start within a second or two — a brief reload blip, not a wait for the
  next map, and not a separate host step. This works for anon invite-link guests
  too: once the owner's game is live, any guest's one click is a hot-join.
</p>

<h2>Player colors</h2>
<p>
  Each player slot gets a fixed color — the vanilla DOOM marine palette — used
  for the card's slot badge ("P1".."P4"), the header tint, and the in-game
  marine sprite. Slots are 1-based in the UI ("Player 1" = slot 0).
</p>
<table class="color-table">
  <thead>
    <tr><th>Slot</th><th>Player</th><th>Color</th><th>Swatch</th></tr>
  </thead>
  <tbody>
    {#each DOOM_SLOT_COLORS as c, i (i)}
      <tr>
        <td><code>{i}</code></td>
        <td>Player {i + 1}</td>
        <td>{c.name}</td>
        <td>
          <span class="swatch" style:background={c.color}></span>
          <code>{c.color}</code>
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<h2>Controls</h2>
<p>
  Click the card to give it keyboard focus, then play. Keys are released
  automatically when the card loses focus or the tab is hidden (no stuck
  movement).
</p>
<table class="keymap">
  <thead>
    <tr><th>Key</th><th>Action</th></tr>
  </thead>
  <tbody>
    {#each KEYMAP as k (k.keys)}
      <tr><td><kbd>{k.keys}</kbd></td><td>{k.action}</td></tr>
    {/each}
  </tbody>
</table>

<h2>Notes</h2>
<ul>
  <li>Only the rack owner can add DOOM — one shared card per rack.</li>
  <li>A guest's Join is disabled until the owner is running a live multiplayer
    game; then it's a one-click hot-join into the running level.</li>
  <li>A player who closes their tab or leaves mid-level vanishes from the game
    (vanilla DOOM behavior); the arbiter frees their slot for the next joiner.</li>
  <li>Single player is owner-only: a lone owner plays a normal single-player game
    with no netcode involved. Guests never get a single-player path.</li>
  <li>No save/load in multiplayer, matching the original game.</li>
</ul>

<nav class="prev-next">
  <span></span>
  <a href="/docs/modules" class="all">all modules</a>
  <span></span>
</nav>

<style>
  .steps {
    line-height: 1.7;
  }
  .color-table,
  .keymap {
    width: 100%;
    margin: 1rem 0 2rem;
  }
  .color-table th,
  .keymap th {
    text-align: left;
  }
  .swatch {
    display: inline-block;
    width: 1.1em;
    height: 1.1em;
    border-radius: 2px;
    vertical-align: middle;
    margin-right: 6px;
    border: 1px solid var(--doc-border-dim, #062b32);
  }
  kbd {
    font-family: var(--doc-mono);
    font-size: 0.82em;
    border: 1px solid var(--doc-border-dim, #062b32);
    border-radius: 3px;
    padding: 1px 6px;
    background: var(--doc-bg);
  }
  .prev-next {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 1rem;
    margin: 3rem 0 0;
    padding-top: 1rem;
    border-top: 1px solid var(--doc-border-dim, #062b32);
    font-size: 0.86em;
  }
  .prev-next .all {
    color: var(--doc-fg-dim, #6e7a82);
  }
</style>
