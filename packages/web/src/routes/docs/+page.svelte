<script lang="ts">
  import { browser } from '$app/environment';

  let { data } = $props();
  void browser;
</script>

<svelte:head>
  <title>patchtogether.live — docs</title>
  <meta name="description" content="Multiplayer browser-native modular synthesizer. How the patch graph, sync, audio engine, and 3-tier deploy fit together." />
</svelte:head>

<section class="hero">
  <h1>patchtogether.live</h1>
  <div class="sub">Multiplayer browser-native modular synthesizer. Patches are CRDT-shared; audio runs locally.</div>
</section>

<p>
  Performers patch a shared rack live in their browser. The patch graph is the canonical state — audio (today)
  and visuals (later) are renderers of that graph. Authoring is collaborative; rendering is local.
</p>

<p>
  Currently <strong>{data.moduleCount} audio modules</strong> in the registry. Catalog: <a href="/docs/modules">/docs/modules</a>.
</p>

<h2>Multi-user model</h2>
<p>
  Authoring runs over a Yjs doc accessed through SyncedStore (the patch graph). A
  <a href="https://hocuspocus.dev">Hocuspocus</a> server on Fly.io brokers updates between
  rackspace participants and persists snapshots to Neon Postgres. Auth is
  <a href="https://clerk.com">Clerk</a> for signed-in users; an HMAC-derived
  invite link (<code>/r/[id]?invite=&lt;code&gt;</code>) lets anonymous users join without an account.
  Cap: 4 concurrent users per rackspace (1 owner + 3 others); the 5th visitor gets a
  <code>/full</code> page. Anonymous edits persist in the shared graph the same as any signed-in user's.
</p>

<h2>DSP pipeline</h2>
<p>
  Two flavors of audio module sit behind a uniform <code>AudioModuleDef</code> registry:
</p>
<ul>
  <li><strong>Faust → WASM</strong>. Most generators / filters / effects are
    <code>.dsp</code> files compiled to WebAssembly + an AudioWorkletProcessor wrapper. See
    <code>packages/dsp/src/*.dsp</code>.</li>
  <li><strong>TS AudioWorklets</strong>. Modules that need clock arithmetic, lookahead schedulers,
    or buffer state in JS land — LFO, Wavetable VCO, TIMELORDE, CHARLOTTE'S ECHOS — ship as
    hand-written <code>AudioWorkletProcessor</code> classes in <code>packages/dsp/src/*.ts</code>.</li>
</ul>
<p>
  The web runtime imports each module's compiled artifact via Vite's <code>?url</code>
  asset pipeline; the module factory wires up <code>ChannelMerger</code> / <code>Splitter</code>
  nodes so per-port mono signals route into the right Faust / worklet input channels.
</p>

<h2>Patch graph (Yjs CRDT)</h2>
<p>
  The graph is a <code>Y.Doc</code> with <code>nodes</code>, <code>edges</code>, and per-user <code>layouts</code>.
  A <code>PatchEngine</code> reconciler diffs the live graph against a per-domain rendering engine
  (today: audio) and issues add / remove / setParam calls. The architecture is multi-domain from
  day 1 so visual modules (LZX-style) can register a second engine without re-plumbing.
</p>

<h2>Persistence</h2>
<p>
  Neon Postgres, one project, three branches (<code>production</code> / <code>autotest</code> / <code>dev</code>).
  The web tier on Cloudflare Workers can only reach Postgres through Neon's HTTP <code>neon</code>
  template tag (<code>pg</code> sockets and the WebSocket <code>Pool</code> both fail in
  Workers — see <a href="/docs/deploy">deploy notes</a>). Hocuspocus on Fly runs Node
  and uses standard <code>pg.Pool</code> over TCP. Rackspace metadata, owner, member list, and
  Yjs snapshots all live in Postgres.
</p>

<h2>Deploy topology</h2>
<p>
  Three tiers, fan-out from a single repo:
</p>
<ul>
  <li><strong>prod</strong> — <code>patchtogether.live</code>. Gated on a
    <code>package.json:.version</code> bump in a merge commit.</li>
  <li><strong>autotest</strong> — <code>autotest.patchtogether.live</code>. Auto-deploys on every
    push to <code>main</code>. Beta-gated (basic-auth <code>beta:robotsonly</code>).</li>
  <li><strong>dev</strong> — <code>dev.patchtogether.live</code>. Same as autotest, separate Hocuspocus
    and Neon branch. Beta-gated (<code>beta:2600hz</code>).</li>
</ul>
<p>
  Each tier maps to its own Cloudflare Pages project, Fly Hocuspocus app, and Neon Postgres branch.
  See <a href="/docs/deploy">deploy</a> for the full topology.
</p>

<h2>What to read next</h2>
<ul>
  <li><a href="/docs/modules">Module catalog</a> — every module, its I/O, params, source link.</li>
  <li><a href="/docs/testing">Testing</a> — unit / ART / E2E layers.</li>
  <li><a href="/docs/deploy">Deploy + ops</a> — the 3-tier flow, Workers↔Postgres caveats.</li>
</ul>
