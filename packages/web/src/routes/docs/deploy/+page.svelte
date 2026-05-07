<svelte:head>
  <title>deploy · patchtogether.live</title>
  <meta name="description" content="3-tier deploy topology and Workers↔Postgres caveats." />
</svelte:head>

<section class="hero">
  <h1>deploy + ops</h1>
  <div class="sub">3 tiers · Cloudflare Pages · Fly.io · Neon Postgres</div>
</section>

<h2>Tier topology</h2>
<table>
  <thead>
    <tr>
      <th>tier</th>
      <th>web URL</th>
      <th>CF Pages project</th>
      <th>Fly Hocuspocus app</th>
      <th>Neon branch</th>
      <th>beta gate</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>prod</td>
      <td><code>patchtogether.live</code></td>
      <td><code>patchtogether-live</code></td>
      <td><code>patchtogether-server</code></td>
      <td><code>production</code></td>
      <td>off</td>
    </tr>
    <tr>
      <td>autotest</td>
      <td><code>autotest.patchtogether.live</code></td>
      <td><code>patchtogether-live-autotest</code></td>
      <td><code>patchtogether-server-autotest</code></td>
      <td><code>autotest</code></td>
      <td><code>beta:robotsonly</code></td>
    </tr>
    <tr>
      <td>dev</td>
      <td><code>dev.patchtogether.live</code></td>
      <td><code>patchtogether-live-dev</code></td>
      <td><code>patchtogether-server-dev</code></td>
      <td><code>dev</code></td>
      <td><code>beta:2600hz</code></td>
    </tr>
  </tbody>
</table>

<h2>What deploys when</h2>
<ul>
  <li>
    <strong>PR open / push</strong> → preview at
    <code>pr-N.patchtogether-live-autotest.pages.dev</code>. Inherits the autotest Clerk env so
    auth round-trips work.
  </li>
  <li>
    <strong>merge to main</strong> → autotest + dev fan-out, in parallel. Both stay in sync.
  </li>
  <li>
    <strong>version bump on main</strong> → prod deploy. Detected by diffing
    <code>package.json:.version</code> against <code>HEAD~1</code>.
  </li>
  <li>
    <strong>workflow_dispatch</strong> → manual override. Requires the latest CI run on the
    chosen branch to be green.
  </li>
</ul>

<h2>Why Cloudflare Pages can't drive Postgres directly</h2>
<p>Three Postgres drivers were tried in sequence; only one works from Workers:</p>
<ul>
  <li>
    <code>pg.Client</code> over TCP — fails. Workers' <code>node:net</code> shim returns
    <em>"proxy request failed"</em>; <code>pg</code>'s socket layer doesn't speak
    <code>cloudflare:sockets</code>.
  </li>
  <li>
    <code>@neondatabase/serverless</code> WebSocket <code>Pool</code> — fails. CF's egress proxy
    403s the outbound WebSocket handshake.
  </li>
  <li>
    <code>@neondatabase/serverless</code> HTTP <code>neon</code> template tag — works.
    <code>fetch()</code> under the hood.
  </li>
</ul>
<p>
  Consequence: anything in <code>packages/web/src/lib/server/</code> that needs atomicity has to
  be a single SQL statement, typically a CTE. See <code>rackspaces.ts</code> for the pattern. The
  Hocuspocus server on Fly is regular Node — it uses <code>pg.Pool</code> over TCP without
  trouble.
</p>

<h2>Beta gate</h2>
<p>
  Basic-auth wrapper enforced in <code>hooks.server.ts</code>. Off in prod, on in autotest + dev.
  <code>/api/health</code> bypasses the gate (live-smoke + uptime probes), and so does the
  <code>/docs/*</code> tree (so the in-app docs read the same pre- and post-launch).
  Browser auth + session flows still work behind it because Playwright passes credentials via
  <code>use.httpCredentials</code>.
</p>

<h2>Hocuspocus on Fly</h2>
<p>
  Three Fly apps, one per tier. Each app runs the
  <code>@patchtogether.live/server</code> Node bundle — Hocuspocus + Clerk JWT verification +
  capacity enforcement (4 connections per <code>doc</code>). Yjs snapshots flush to the matching
  Neon branch. WebSocket URL is baked into the web bundle at build time via
  <code>VITE_SERVER_WS_URL</code>.
</p>

<h2>Local dev shortcut</h2>
<pre><code>flox activate -- task setup     # install + Playwright Chromium
flox activate -- task dev       # SvelteKit + DSP one-shot build
flox activate -- task server:dev # Hocuspocus on ws://localhost:1235</code></pre>
<p>
  Hocuspocus binds 1235, not 1234 — BitwigStudio reserves 1234 for OSC on this machine. Postgres
  for local dev: see <code>db/README.md</code>.
</p>
