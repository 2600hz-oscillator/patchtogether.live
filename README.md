# inet.modular

A multiplayer browser-native modular synthesizer.

> **Codebase:** `inet.modular` &nbsp;·&nbsp; **Deployed as:** [patchtogether.live](https://patchtogether.live)

Performers patch a shared rack live in their browser; audience members listen via a stream. The patch graph is the canonical state — everything else (audio, UI, eventually visuals) is a renderer of that graph.

This repo is in early MVP. See the open PR for what's currently shipping.

## Status

**Phase 1 (single-user MVP)** — in progress. Core engine, ~10 audio modules, deterministic patch tests. Multi-user comes in Phase 4.

## Quickstart

This project uses **[Flox](https://flox.dev)** to pin the toolchain (Node 22, Faust 2.85.5, esbuild, go-task, git-lfs, gh) and **[go-task](https://taskfile.dev)** as the single command surface.

```bash
flox activate -- task setup     # one-time: npm install + Playwright browser
flox activate -- task dev       # start the dev server + DSP file watch
flox activate -- task ci        # run the full PR-gate suite
flox activate -- task           # list every available target
```

If you stay inside `flox activate` (one shell), drop the `flox activate --` prefix.

## Layout

```
packages/web        SvelteKit app (Svelte 5, Svelte Flow, Web Audio)
packages/dsp        Faust DSP source + JS AudioWorklets → built to WASM
e2e                 Playwright end-to-end tests (full app, real Web Audio)
art                 Audio Regression Tests (deterministic offline render + bit-accurate baselines)
vrt                 Visual Regression Tests (planned)
```

## Architecture (one-liner)

A `PatchEngine` (domain dispatcher) reconciles a shared patch graph (SyncedStore over Yjs) into per-domain rendering engines. Today there's one domain — `audio` — backed by Web Audio. The architecture is multi-domain from day one so visual modules (LZX-style) can drop in later without re-plumbing.

## License

See [LICENSE](./LICENSE).
