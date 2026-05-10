<script lang="ts">
  // Static doc page — explains the three-tier persistence stack and the
  // .imp.json export/import format. No data dependencies; everything ships
  // at build time via the docs subtree's prerender + ssr config.
</script>

<svelte:head>
  <title>persistence · patchtogether.live · docs</title>
  <meta
    name="description"
    content="How rackspaces, patches, and assets persist across reloads, disconnects, and exports."
  />
</svelte:head>

<section class="hero">
  <h1>rackspace persistence</h1>
  <div class="sub">
    Where your patch lives, when it gets written, and how to take it with you.
  </div>
</section>

<h2>tl;dr</h2>
<p>
  You don't need to click <strong>Save</strong>. While you edit a rackspace, every change
  auto-syncs to the collaboration server (Hocuspocus) and is debounced into a
  durable Postgres snapshot a few seconds later. Reload the page, close the
  tab, come back tomorrow — your rack is exactly as you left it.
</p>
<p>
  The <strong>Save</strong> button is for <em>exporting a portable backup file</em>
  (<code>.imp.json</code>). Use it for: snapshot-before-an-experiment,
  send-this-rack-to-a-friend, version-control the patch alongside your code,
  or move a rack between accounts. The <strong>Load</strong> button reads one of
  those files back, replacing the current rack.
</p>

<h2>the three tiers</h2>
<pre><code>  Browser (per user)
    +- Y.Doc (graph/store.ts, syncedStore-wrapped)
    |    +- ydoc.getMap('nodes')   &lt;- node.id -&gt; ModuleNode (incl. node.data)
    |    +- ydoc.getMap('edges')   &lt;- edge.id -&gt; Edge
    |    +- ydoc.getMap('layouts') &lt;- per-user position overrides
    |
    +- Hocuspocus WS provider (lib/multiplayer/provider.ts)
         &lt;- bidirectional Yjs CRDT updates over WebSocket -&gt;
  ----------------------------------------------------------
  Hocuspocus server (packages/server, Fly.io)
    +- onAuthenticate  -&gt; Clerk JWT or anon HMAC invite
    +- onLoadDocument  -&gt; loadSnapshot(rackId) -&gt; Y.applyUpdate
    +- onStoreDocument (DEBOUNCED)
         +- debounce: 2000 ms
         +- maxDebounce: 5000 ms
         +- unloadImmediately: true   (last-client flush guarantee)
  ----------------------------------------------------------
  Postgres (Neon, db/schema/001_init.sql)
    +- racks            (id, owner, name, timestamps)
    +- rack_members     (rack_id, user_id, role)
    +- rack_snapshots   (rack_id PK, yjs_state bytea, updated_at)</code></pre>

<h2>what's persisted</h2>
<p>
  Anything stored under <code>node.data</code> or <code>node.params</code> rides the
  Y.Doc and is therefore part of the snapshot. That includes:
</p>
<ul>
  <li>Patch graph: nodes, edges, knob positions.</li>
  <li>Per-user node positions (multiplayer doesn't make you fight over layout).</li>
  <li>Sequencer step data (notes, midi, chord mode).</li>
  <li>SCORE pages, ties, dynamics.</li>
  <li>DRUMSEQZ track grids + per-track Euclidean settings.</li>
  <li>POLYSEQZ chord steps (root, quality, inversion, voicing, humanize).</li>
  <li>Sequencer / DRUMSEQZ / SCORE / POLYSEQZ quicksave slots
    (4 per module, accessible via the transport card).</li>
  <li>PICTUREBOX images — uploaded files are downscaled to 640x480 JPEG and
    base64-stored in <code>node.data.imageBytes</code>, so the image is part of
    the rack and shows up for everyone.</li>
  <li>DX7 user banks — uploaded <code>.syx</code> cartridges are parsed into
    <code>node.data.userPatches</code>; the selected preset name is in
    <code>node.data.preset</code>.</li>
</ul>
<p>
  Things that are intentionally <em>not</em> persisted in the rack:
</p>
<ul>
  <li>The webcam feed from a CAMERA module — local-only by design; only its presence
    is broadcast as awareness.</li>
  <li>Skin preference — per-browser localStorage today (so the same account can pick
    different skins per device).</li>
</ul>

<h2>the .imp.json envelope</h2>
<p>
  The Save / Load buttons in the canvas topbar produce and consume a single JSON
  envelope, format <code>envelopeVersion: 1</code>:
</p>
<pre><code>{`{
  "envelopeVersion": 1,
  "savedAt":         "2026-05-09T12:34:56.000Z",
  "moduleSchemas":   { "analogVco": 1, "picturebox": 2, "dx7": 1, ... },
  "update":          "<base64 of Y.encodeStateAsUpdate(ydoc)>"
}`}</code></pre>
<p>
  The <code>update</code> field is the actual source of truth — the same bytes the
  Hocuspocus server stores in <code>rack_snapshots.yjs_state</code>. Loading an
  envelope decodes that update into a fresh Y.Doc and atomically swaps the live
  rack contents for the loaded ones. <code>moduleSchemas</code> drives per-module
  data migrations on load — if a saved patch's PICTUREBOX is at v1 and the running
  build is at v2, the v1 -&gt; v2 migration runs before the node is added to the
  live store.
</p>

<h2>limits + future evolution</h2>
<p>
  A maxed-out rack today (8 PICTUREBOX with images, 32 DX7 SYX user banks, ~50
  modules, 4 active users with their own layouts) sits at roughly 1.5 MB. Postgres
  <code>bytea</code> handles that comfortably and the Cloudflare Workers request
  body limit (25 MB) leaves an order of magnitude of headroom.
</p>
<p>
  When typical rack sizes cross ~5 MB (think 1080p PICTUREBOX images, video loops,
  longer DX7 banks), the persistence path swaps the all-in-one Y.Doc snapshot for a
  content-addressed asset table — bytes hash to a row in <code>rack_assets</code>,
  the patch keeps a hash reference in <code>node.data</code>. Hashes dedupe across
  racks (same image used 4 times = stored once). Beyond ~25 MB, those bytes move to
  Cloudflare R2 and the Postgres table holds the URL. Both migrations are additive
  and leave the user-facing Save / Load story unchanged.
</p>

<h2>see also</h2>
<ul>
  <li><a href="/docs/deploy">Deploy</a> — Workers / Fly / Neon topology.</li>
  <li><a href="/docs/modules">Module catalog</a> — every module's I/O + which fields
    live under <code>node.data</code>.</li>
</ul>
