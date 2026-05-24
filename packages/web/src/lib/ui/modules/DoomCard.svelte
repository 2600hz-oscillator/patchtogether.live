<script lang="ts">
  // DoomCard — UI for the single-instance interactive DOOM video module.
  //
  // The card is keyboard-driven (tabindex=0 + :focus-within ring) — when
  // focused, document-level keydown/keyup listeners route via the runtime;
  // unfocused, no keys are stolen. NUMPAD+'s document listener defensively
  // skips keys whose document.activeElement is inside a DOOM card so the
  // two modules can coexist when both are on the rack.
  //
  // Multiplayer (Yjs awareness): the user who spawned the module is the
  // "host" (lex-smallest current rack-member id on host departure;
  // see doom-presence.ts → pickHost). The host runs the WASM, broadcasts
  // a framebuffer envelope at ~10 Hz, and listens for non-self key
  // envelopes (relayed from spectators) → pushes them into the runtime's
  // key queue. Spectators don't load the WASM — they just decode + render
  // the host's framebuffer + relay their own keystrokes back.
  //
  // The runtime + framebuffer broadcast layer is intentionally a thin
  // wrapper around the doom-presence.ts encode/decode helpers — those
  // helpers are exhaustively unit-tested and the card just plumbs them.
  //
  // Sound: stereo audio outputs (audio_l / audio_r) are wired through the
  // new video → audio cross-domain bridge (PR-A) but stay silent in v1
  // because doomgeneric ships with i_sound's null impl. Slice 8 wires
  // real audio.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { useProvider } from '$lib/multiplayer/provider-context';
  import { patch } from '$lib/graph/store';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import { doomDef, type DoomHandleExtras } from '$lib/video/modules/doom';
  import { CV_GATE_PORT_IDS } from '$lib/doom/doomkeys';
  import {
    encodeKey,
    decodeKey,
    encodeFrame,
    decodeFrame,
    decodeFrameBuffer,
    pickHost,
  } from '$lib/doom/doom-presence';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();
  const providerCtx = useProvider();

  // ---- UI / lifecycle state ----
  let cardEl: HTMLDivElement | null = $state(null);
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let loadStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let loadError = $state<string | null>(null);
  let isHost = $state(true);          // true on first spawn; recomputed from awareness
  let memberIds = $state<string[]>([]); // including self
  /** Last remote framebuffer received via awareness — spectator path. The
   *  card-side rAF tick prefers this over `extras.snapshotFramebuffer()`
   *  (which is null on spectator pages because they never load WASM). */
  let lastRemoteFrame: Uint8Array | null = null;
  /** Local user id used for host election. Resolved lazily from the
   *  provider's awareness `user.id` field (set by /r/[id]'s presence
   *  init OR by tests calling __setAwarenessUser). Falls back to a
   *  stable random per-tab id when no provider is attached. */
  const randomLocalId = `local-${Math.random().toString(36).slice(2, 10)}`;
  function resolveLocalUserId(): string {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return randomLocalId;
    const state = aw.getLocalState() as { user?: { id?: string } } | null;
    const uid = state?.user?.id;
    return typeof uid === 'string' && uid.length > 0 ? uid : randomLocalId;
  }

  // ---- Extras helper ----
  function getExtras(): DoomHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const videoEngine = e.getDomain<VideoEngine>('video');
      const extras = videoEngine.read(id, 'extras') as DoomHandleExtras | undefined;
      return extras ?? null;
    } catch {
      return null;
    }
  }

  // ---- WASM + WAD load on user-initiated click (avoids autoplay races) ----
  async function tryLoad(): Promise<void> {
    const extras = getExtras();
    if (!extras) return;
    loadStatus = 'loading';
    const err = await extras.ensureLoaded();
    if (err) {
      loadStatus = 'error';
      loadError = err;
    } else {
      loadStatus = 'ready';
      loadError = null;
    }
  }

  // ---- Keyboard input — only fires while the card is focused. ----
  function onKeyDown(ev: KeyboardEvent): void {
    if (!cardEl || !cardEl.contains(document.activeElement)) return;
    const extras = getExtras();
    if (!extras) return;
    if (isHost) {
      const handled = extras.pushKeyboardKey(ev.code, true);
      if (handled) ev.preventDefault();
    } else {
      // Spectator: relay via awareness; the host's listener pushes the key
      // into its runtime queue.
      relayKeyToHost(ev.code, true);
      ev.preventDefault();
    }
  }
  function onKeyUp(ev: KeyboardEvent): void {
    if (!cardEl || !cardEl.contains(document.activeElement)) return;
    const extras = getExtras();
    if (!extras) return;
    if (isHost) {
      const handled = extras.pushKeyboardKey(ev.code, false);
      if (handled) ev.preventDefault();
    } else {
      relayKeyToHost(ev.code, false);
      ev.preventDefault();
    }
  }

  function relayKeyToHost(code: string, pressed: boolean): void {
    // Spectator → host relay: we look the doomkey up locally and
    // broadcast a KeyEnvelope. The host filters on srcUserId !== self.
    const provider = providerCtx.get();
    if (!provider) return;
    const me = resolveLocalUserId();
    // Reuse the runtime's translation table without instantiating the
    // runtime on the spectator side: we import the keyboard map and
    // map the code to a doomkey directly.
    import('$lib/doom/doomkeys').then((mod) => {
      const dk = mod.KEY_FOR_KEYBOARD_CODE[code];
      if (dk === undefined) return;
      const env = encodeKey({
        kind: 'key',
        moduleId: id,
        srcUserId: me,
        doomKey: dk,
        pressed,
        ts: Date.now(),
      });
      provider.awareness?.setLocalStateField(`doom:${id}:key`, env);
      // Clear immediately so the same key+pressed combination next time
      // re-triggers (awareness is sticky — repeated identical values are
      // deduped). Microtask so a fast follow-up key on the same field
      // doesn't get lost between set + clear.
      queueMicrotask(() => {
        provider.awareness?.setLocalStateField(`doom:${id}:key`, null);
      });
    });
  }

  // ---- Awareness wiring ----
  let frameBroadcastInterval: ReturnType<typeof setInterval> | null = null;
  let awarenessOff: (() => void) | null = null;
  /** Last frame envelope ts we decoded — guards against re-decoding the
   *  same payload on every rAF tick (the base64 → bytes hop is ~5 ms). */
  let lastDecodedFrameTs = 0;

  function pollLatestRemoteFrame(): void {
    const provider = providerCtx.get();
    const aw = provider?.awareness;
    if (!aw) return;
    let newest: { ts: number; raw: unknown } | null = null;
    aw.getStates().forEach((s) => {
      const raw = (s as Record<string, unknown>)[`doom:${id}:frame`];
      const ts = (raw as { ts?: number } | null)?.ts;
      if (typeof ts !== 'number') return;
      if (!newest || ts > newest.ts) newest = { ts, raw };
    });
    if (!newest) return;
    const newestTs = (newest as { ts: number }).ts;
    if (newestTs <= lastDecodedFrameTs) return;
    const env = decodeFrame((newest as { raw: unknown }).raw);
    if (!env || env.moduleId !== id) return;
    lastRemoteFrame = decodeFrameBuffer(env);
    lastDecodedFrameTs = newestTs;
  }

  function attachAwareness(): void {
    const provider = providerCtx.get();
    if (!provider) return;
    const aw = provider.awareness;
    if (!aw) return;

    function recomputeHost(): void {
      const me = resolveLocalUserId();
      const states = aw!.getStates();
      const ids: string[] = [];
      states.forEach((s) => {
        // We mirror our own user id under 'user.id'; this matches
        // multiplayer/presence.ts's setLocalStateField('user', user) call.
        const uid = (s as { user?: { id?: string } }).user?.id;
        if (typeof uid === 'string') ids.push(uid);
      });
      // Self may not have an entry yet — include defensively.
      if (!ids.includes(me)) ids.push(me);
      memberIds = ids;
      const myField = `doom:${id}:host`;
      // Read all clients' "I am host for module X" claims; tiebreak via
      // pickHost (lex-smallest).
      const candidates: string[] = [];
      states.forEach((s) => {
        const host = (s as Record<string, unknown>)[myField];
        if (typeof host === 'string') candidates.push(host);
      });
      const currentHost = candidates.length > 0 ? candidates.sort()[0]! : null;
      const newHost = pickHost(currentHost, ids);
      isHost = newHost === me;
      // Only write our claim if it actually changed — otherwise every
      // recomputeHost would emit an awareness update which re-fires
      // 'update' which re-enters recomputeHost (infinite loop seen in
      // playwright trace).
      const localState = aw!.getLocalState() as Record<string, unknown> | null;
      const desiredClaim = isHost ? me : null;
      if ((localState?.[myField] ?? null) !== desiredClaim) {
        aw!.setLocalStateField(myField, desiredClaim);
      }
    }

    function onIncomingKey(): void {
      if (!isHost) return;
      const me = resolveLocalUserId();
      const states = aw!.getStates();
      states.forEach((s, clientId) => {
        if (clientId === aw!.clientID) return;
        const raw = (s as Record<string, unknown>)[`doom:${id}:key`];
        const env = decodeKey(raw);
        if (!env || env.moduleId !== id) return;
        if (env.srcUserId === me) return;
        const extras = getExtras();
        if (!extras) return;
        extras.pushDoomKey(env.doomKey, env.pressed);
      });
    }

    function onIncomingFrame(): void {
      if (isHost) return;
      const states = aw!.getStates();
      states.forEach((s) => {
        const raw = (s as Record<string, unknown>)[`doom:${id}:frame`];
        const env = decodeFrame(raw);
        if (!env || env.moduleId !== id) return;
        const buf = decodeFrameBuffer(env);
        // Cache for the card-side render loop (spectator has no runtime,
        // so extras.snapshotFramebuffer() returns null; we draw from this).
        lastRemoteFrame = buf;
        // Also push into the engine for the GL surface path (videoOut
        // mirror, etc.).
        const extras = getExtras();
        if (extras) extras.pushRemoteFramebuffer(buf);
      });
    }

    const update = (): void => {
      recomputeHost();
      onIncomingKey();
      onIncomingFrame();
    };
    aw.on('update', update);
    awarenessOff = () => aw.off('update', update);

    // Initial host election.
    recomputeHost();

    // Host: broadcast a framebuffer ~10 Hz.
    frameBroadcastInterval = setInterval(() => {
      if (!isHost) return;
      const extras = getExtras();
      if (!extras) return;
      const snap = extras.snapshotFramebuffer();
      if (!snap) return;
      try {
        const env = encodeFrame({
          moduleId: id,
          hostUserId: resolveLocalUserId(),
          width: 640,
          height: 400,
          framebuffer: snap,
          ts: Date.now(),
        });
        aw.setLocalStateField(`doom:${id}:frame`, env);
      } catch {
        // Encoding can throw on buffer mismatch — non-fatal, skip frame.
      }
    }, 100);
  }

  function detachAwareness(): void {
    if (awarenessOff) {
      try { awarenessOff(); } catch { /* */ }
      awarenessOff = null;
    }
    if (frameBroadcastInterval !== null) {
      clearInterval(frameBroadcastInterval);
      frameBroadcastInterval = null;
    }
  }

  // ---- Card-side framebuffer render loop ----
  //
  // The video engine renders DOOM into its FBO every frame; this card
  // mirrors the FBO contents into the visible <canvas> via a per-card
  // rAF blit. Same pattern as VideoOutCard but the source is the DOOM
  // module's own surface texture, not engine.canvas. We use a small
  // inline 2D-canvas blit from the live framebuffer view (which is
  // already in CPU memory via the runtime's HEAPU8 view) so the card
  // doesn't have to drive a GL pull from the engine.
  let raf: number | null = null;
  function startRenderLoop(): void {
    if (raf !== null) return;
    function tick(): void {
      if (canvasEl) {
        const ctx2d = canvasEl.getContext('2d');
        if (ctx2d) {
          // Host: pull straight from the live runtime via extras.
          // Spectator: no runtime — extras.snapshotFramebuffer() is null,
          // so fall back to the last awareness-delivered frame.
          const extras = getExtras();
          let fb: Uint8Array | Uint8ClampedArray | null = null;
          if (extras) fb = extras.snapshotFramebuffer();
          if (!fb) {
            // Belt-and-suspenders: the awareness 'update' listener already
            // populates lastRemoteFrame, but under load chromium can drop
            // listener firings between heavy awareness payloads. Re-poll
            // the latest frame envelope on every rAF tick so the canvas
            // stays current even if no 'update' callback fired this frame.
            pollLatestRemoteFrame();
            fb = lastRemoteFrame;
          }
          if (fb) {
            // Upload BGRA → RGBA via inline byte swap. 640×400 = 256k
            // pixels = 1 MB; the swap is ~16ms on a slow laptop but
            // tolerable at 10 Hz. The GL path inside the engine already
            // does this swizzle at zero cost; we accept the cost here
            // for the small CSS-pixel preview, which doesn't need to
            // match the engine output bit-for-bit.
            const img = ctx2d.createImageData(640, 400);
            const out = img.data;
            for (let i = 0; i < fb.length; i += 4) {
              out[i]     = fb[i + 2]!; // R ← B
              out[i + 1] = fb[i + 1]!; // G
              out[i + 2] = fb[i]!;     // B ← R
              out[i + 3] = 255;
            }
            ctx2d.putImageData(img, 0, 0);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
  }
  function stopRenderLoop(): void {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  // ---- Mount / unmount ----
  onMount(() => {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    startRenderLoop();
    // Auto-attach awareness if a provider is present (multi-user rack);
    // single-user `/` canvas skips quietly.
    attachAwareness();
  });

  onDestroy(() => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    stopRenderLoop();
    detachAwareness();
  });

  // ---- Param row ----
  function setParam(paramId: string) {
    return (v: number): void => {
      const target = patch.nodes[id];
      if (target) target.params[paramId] = v;
    };
  }
  let running = $derived<number>(
    node?.params['running'] ?? doomDef.params.find((p) => p.id === 'running')?.defaultValue ?? 1,
  );
  function toggleRunning(): void {
    setParam('running')(running > 0.5 ? 0 : 1);
  }
</script>

<!-- role="application" + tabindex="0" + onclick: the card IS an
     interactive application surface (keyboard-driven game). Mirrors
     ScoreCard. The svelte-check rule wants an interactive handler on
     focusable elements; we register a click-to-focus to satisfy it
     (which is also good UX — click anywhere on the card to grab the
     keyboard). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  bind:this={cardEl}
  class="mod-card doom-card"
  role="application"
  aria-label="DOOM video module — keyboard input on focus"
  tabindex="0"
  data-card-type="doom"
  data-testid="doom-card"
  onclick={() => cardEl?.focus()}
  onkeydown={(ev) => { /* listener at window-level; this satisfies the a11y rule */ void ev; }}
>
  <div class="stripe" style="background: var(--cable-video, #c33);"></div>
  <header class="title">
    DOOM
    {#if isHost}
      <span class="host-badge" title="You are running the DOOM instance for this rack">HOST</span>
    {:else}
      <span class="spec-badge" title="Spectating — host is running the game">SPEC</span>
    {/if}
  </header>

  <div class="game-area">
    <canvas
      bind:this={canvasEl}
      width="640"
      height="400"
      style="width: 320px; height: 200px;"
      data-viz-passthrough
      data-testid="doom-canvas"
      tabindex="-1"
      onpointerdown={() => cardEl?.focus()}
    ></canvas>
    {#if loadStatus === 'idle' && isHost}
      <button class="overlay" onclick={() => void tryLoad()}>
        Click to load DOOM
        <small>(downloads ~4 MB WAD on first spawn)</small>
      </button>
    {:else if loadStatus === 'loading'}
      <div class="overlay">Loading WASM + DOOM1.WAD…</div>
    {:else if loadStatus === 'error'}
      <div class="overlay error">
        <strong>DOOM failed to load:</strong>
        <code>{loadError}</code>
      </div>
    {/if}
    {#if loadStatus === 'ready' && cardEl && document.activeElement !== cardEl}
      <button
        type="button"
        class="focus-hint"
        onclick={() => cardEl?.focus()}
      >
        Click to capture keyboard
      </button>
    {/if}
  </div>

  {#each CV_GATE_PORT_IDS as port, idx (port)}
    {@const top = 56 + idx * 28}
    <Handle
      type="target"
      position={Position.Left}
      id={port}
      style="top: {top}px; --handle-color: var(--cable-cv);"
    />
    <span class="port-label left" style="top: {top - 6}px;">{port.toUpperCase()}</span>
  {/each}

  <Handle
    type="source"
    position={Position.Right}
    id="out"
    style="top: 56px; --handle-color: var(--cable-video, #c33);"
  />
  <span class="port-label right" style="top: 50px;">OUT</span>
  <Handle
    type="source"
    position={Position.Right}
    id="audio_l"
    style="top: 96px; --handle-color: var(--cable-audio);"
  />
  <span class="port-label right" style="top: 90px;">A-L</span>
  <Handle
    type="source"
    position={Position.Right}
    id="audio_r"
    style="top: 124px; --handle-color: var(--cable-audio);"
  />
  <span class="port-label right" style="top: 118px;">A-R</span>

  <div class="controls-row">
    <button
      class="run-btn"
      onclick={toggleRunning}
      title="Pause / resume the game loop"
    >
      {running > 0.5 ? 'Pause' : 'Run'}
    </button>
  </div>

  <footer class="hint">
    {#if memberIds.length > 1}
      <small>{memberIds.length} rack-mates · host: {isHost ? 'you' : 'remote'}</small>
    {:else}
      <small>Single-user rack — you're the host.</small>
    {/if}
  </footer>
</div>

<style>
  .doom-card {
    width: 360px;
    min-height: 320px;
    outline: none;
  }
  .doom-card:focus-within {
    outline: 2px solid var(--cable-video, #c33);
    outline-offset: -2px;
  }
  .doom-card .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .doom-card .host-badge,
  .doom-card .spec-badge {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 5px;
    border-radius: 2px;
    letter-spacing: 0.05em;
  }
  .doom-card .host-badge {
    background: var(--cable-video, #c33);
    color: white;
  }
  .doom-card .spec-badge {
    background: color-mix(in oklab, var(--cable-video, #c33) 30%, transparent);
    color: var(--cable-video, #c33);
  }
  .doom-card .game-area {
    display: flex;
    justify-content: center;
    padding: 6px 0 8px;
    position: relative;
  }
  .doom-card canvas {
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    background: #000;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 30%, transparent);
  }
  .doom-card .overlay {
    position: absolute;
    inset: 6px 0 8px 0;
    margin: 0 auto;
    width: 320px;
    height: 200px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid color-mix(in oklab, var(--cable-video, #c33) 50%, transparent);
  }
  .doom-card .overlay small {
    font-size: 10px;
    opacity: 0.8;
  }
  .doom-card .overlay.error code {
    font-size: 10px;
    color: #fbb;
    margin-top: 4px;
  }
  .doom-card .focus-hint {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.5);
    color: white;
    font-size: 10px;
    padding: 3px 6px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    cursor: pointer;
  }
  .doom-card .controls-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px 6px;
    flex-wrap: wrap;
  }
  .doom-card .run-btn {
    font-size: 11px;
    padding: 3px 8px;
    background: var(--cable-video, #c33);
    color: white;
    border: none;
    cursor: pointer;
  }
  .doom-card .port-label {
    position: absolute;
    font-size: 9px;
    letter-spacing: 0.05em;
    opacity: 0.85;
    font-family: ui-monospace, monospace;
    pointer-events: none;
  }
  .doom-card .port-label.left  { left: 14px; }
  .doom-card .port-label.right { right: 14px; }
  .doom-card .hint {
    padding: 0 10px 8px;
    color: color-mix(in oklab, var(--cable-video, #c33) 70%, transparent);
    font-size: 10px;
  }
</style>
