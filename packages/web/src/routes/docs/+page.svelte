<script lang="ts">
  let { data } = $props();
</script>

<svelte:head>
  <title>patchtogether.live · docs</title>
  <meta name="description" content="Multiplayer browser-native modular synthesizer." />
</svelte:head>

<section class="hero">
  <h1>patchtogether.live</h1>
  <div class="sub">
    Multiplayer browser-native modular synthesizer. Audio + video. Patches are CRDT-shared; rendering is local.
  </div>
</section>

<p>
  Performers patch a shared rack live in their browser. The patch graph is the canonical state —
  audio (Web Audio + AudioWorklet) and video (WebGL2 fragment shaders) are renderers of that
  graph. Authoring is collaborative; rendering is local.
</p>

<p>
  <strong>{data.moduleCount} modules</strong> in the registry today (audio + video). Catalog:
  <a href="/docs/modules">/docs/modules</a>. Right-click any module on the canvas to open its
  per-module docs page in a new tab.
</p>

<h2>Multi-user model</h2>
<p>
  Authoring runs over a Yjs doc accessed through SyncedStore (the patch graph). A
  <a href="https://hocuspocus.dev">Hocuspocus</a> server on Fly.io brokers updates between
  rackspace participants and persists snapshots to Neon Postgres. Auth is Clerk; an HMAC-derived
  invite code (<code>/r/[id]?invite=...</code>) lets anonymous users join without an account. Cap:
  4 concurrent users per rackspace (1 owner + 3 others); the 5th visitor gets a <code>/full</code>
  page. Anonymous edits persist in the shared graph the same as any signed-in user's.
</p>

<h2>Domains</h2>
<p>
  Two domains today, with the architecture from day 1 to drop in more:
</p>
<ul>
  <li>
    <strong>Audio.</strong> Web Audio + AudioWorklet. Most DSP is Faust 2 → WASM
    (<code>packages/dsp/src/*.dsp</code>). A handful of modules — LFO, Wavetable VCO, TIMELORDE,
    CHARLOTTE'S ECHOS, DX7 — ship as hand-written <code>AudioWorkletProcessor</code>s in TS
    (<code>packages/dsp/src/*.ts</code>) when they need clock arithmetic, lookahead schedulers,
    or in-JS state. CV cables carry a bipolar −1..+1 signal where ±1 sweeps the target param
    edge-to-edge; per-port <code>cvScale</code> hints (<code>linear</code>/<code>log</code>/
    <code>discrete</code>/<code>passthrough</code>) drive the scaling.
  </li>
  <li>
    <strong>Video.</strong> WebGL2 fragment shaders. Each video module ships its own GLSL +
    a <code>VideoModuleDef</code> factory under
    <code>packages/web/src/lib/video/modules/</code>. Cable types: <code>image</code> (still
    RGB), <code>mono-video</code> (1-channel animated), <code>video</code> (RGB animated),
    <code>keys</code> (1-channel still). Free upcasts handle the obvious widenings.
  </li>
</ul>
<p>
  The graph is a <code>Y.Doc</code> with <code>nodes</code>, <code>edges</code>, and per-user
  <code>layouts</code>. A <code>PatchEngine</code> reconciler diffs the live graph against
  per-domain rendering engines (<code>AudioEngine</code>, <code>VideoEngine</code>) and issues
  add / remove / setParam calls. Audio-side <code>cv</code> cables can also terminate on a
  video module's CV input — the cross-domain bridge reads the audio CV at frame rate and
  pushes it into <code>VideoEngine.setParam</code>.
</p>

<h2>Persistence</h2>
<p>
  Neon Postgres, one project, three branches (<code>production</code> / <code>autotest</code> /
  <code>dev</code>). The web tier on Cloudflare Workers can only reach Postgres through Neon's
  HTTP <code>neon</code> template tag (<code>pg</code> sockets and the WebSocket
  <code>Pool</code> both fail in Workers — see <a href="/docs/deploy">deploy notes</a>).
  Hocuspocus on Fly runs Node and uses standard <code>pg.Pool</code> over TCP. Rackspace
  metadata, owner, member list, and Yjs snapshots all live in Postgres. PICTUREBOX images and
  DX7 user banks ride inside the Yjs snapshot — see
  <a href="/docs/rackspace-persistence">rackspace persistence</a>.
</p>

<h2>Deploy topology</h2>
<p>
  Three tiers, fan-out from a single repo:
</p>
<ul>
  <li>
    <strong>prod</strong> — <code>patchtogether.live</code>. Gated on a
    <code>package.json:.version</code> bump in a merge commit.
  </li>
  <li>
    <strong>autotest</strong> — <code>autotest.patchtogether.live</code>. Auto-deploys on every
    push to <code>main</code>. Beta-gated (basic-auth <code>beta:robotsonly</code>).
  </li>
  <li>
    <strong>dev</strong> — <code>dev.patchtogether.live</code>. Same as autotest, separate
    Hocuspocus and Neon branch. Beta-gated (<code>beta:2600hz</code>).
  </li>
</ul>
<p>
  Each tier maps to its own Cloudflare Pages project, Fly Hocuspocus app, and Neon Postgres
  branch. See <a href="/docs/deploy">deploy</a> for the full topology.
</p>

<h2>What to read next</h2>
<ul>
  <li><a href="/docs/modules">Module catalog</a> — every module, its I/O, params, source link.</li>
  <li>
    <a href="/docs/modules/doom-multiplayer">DOOM multiplayer</a> —
    4-player co-op: starting a game, joining, late-join, player colors, controls.
  </li>
  <li>
    <a href="/docs/modules/grid-clip-launcher">Clip player + monome grid</a> —
    an 8-instrument-lane, TIMELORDE-locked clip launcher you build, launch, scene,
    and edit from a monome grid 128 (WebSerial, no helper).
  </li>
  <li>
    <a href="/docs/rackspace-persistence">Rackspace persistence</a> —
    where patches + assets live, what Save/Load do, what auto-saves.
  </li>
  <li><a href="/docs/testing">Testing</a> — unit / ART / E2E layers + port-surface consistency gates.</li>
  <li><a href="/docs/deploy">Deploy + ops</a> — the 3-tier flow, Workers↔Postgres caveats.</li>
</ul>
