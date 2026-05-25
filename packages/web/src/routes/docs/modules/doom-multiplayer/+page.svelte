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
  instance per peer. When two or more people in the same rackspace each spawn a
  DOOM card, they play a single co-op netgame together — each peer renders its
  own first-person view, and every player's marine appears in every other
  peer's world. Up to <strong>4 players</strong> (one DOOM card per peer).
</p>

<h2>Start a multiplayer game</h2>
<p>The first peer to spawn DOOM is the <strong>arbiter</strong> (the rack host,
chosen by lex-smallest user id — same tiebreak as everything else). The arbiter
drives the game start:</p>
<ol class="steps">
  <li>Spawn a <code>DOOM</code> module on the canvas and click the card to load
    the game (the shareware WAD downloads once, then caches locally).</li>
  <li>Open <strong>New Game</strong> on the card and pick mode (co-op),
    skill, episode, and map.</li>
  <li>Hit <strong>Launch</strong>. Every joined peer enters the same level at
    its own co-op start position, and lockstep play begins.</li>
</ol>
<p>
  Only the arbiter sees the New Game dialog; other players see "waiting for the
  host to start" until Launch. Mode, WAD, and skill are locked for the session —
  changing them means ending the current game.
</p>

<h2>Join an in-progress rack</h2>
<p>When you spawn a DOOM card in a rack that already has one, click
<strong>Join</strong>. The arbiter assigns you the next free player slot
(Player 1 → 4, in order). You don't pick a slot — the arbiter assigns it
deterministically so two simultaneous joins can't collide.</p>

<h2>Late join (hot-drop)</h2>
<p>
  DOOM has no <em>true</em> mid-level join: the original netgame fixes the
  player set when the level starts (<code>G_InitNew</code> spawns one marine per
  active slot, and the lockstep tic stream assumes a constant
  <code>playeringame[]</code>). So spawning a new marine into an
  already-running level mid-tic isn't possible.
</p>
<p>
  We get the same outcome the pragmatic way: when you <strong>Join</strong> a
  game that's already running, the arbiter seats you as an active player and
  immediately <strong>re-launches the current map</strong> (same skill, episode,
  and map — only the player count grows). Every peer reloads the level via
  <code>G_InitNew</code>, so you drop into the <em>current</em> map at your coop
  start within a second or two — a fast reload, not a wait for the next map.
  This works for anon invite-link guests too: clicking Join is itself what opens
  multiplayer, so a guest never needs the host to flip a switch first.
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
  <li>One DOOM card per peer — you can't spawn two.</li>
  <li>A player who closes their tab or leaves mid-level vanishes from the game
    (vanilla DOOM behavior); the arbiter frees their slot for the next joiner.</li>
  <li>Single player still works: a lone peer in a rack plays a normal
    single-player game with no netcode involved.</li>
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
