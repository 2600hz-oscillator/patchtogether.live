// art/setup/faust-fetch-fs.ts
//
// Lets an ART scenario drive a REAL FAUST module factory — `instantiateFaustModule`
// and all — under node-web-audio-api, which `art/setup/offline.ts` could not do.
//
// Two seams stand between a Faust def's `factory()` and a Node render, and this
// file plus the `@grame/faustwasm` alias in vitest.config.ts remove both:
//
//  1. `faust-runtime.ts` imports `@grame/faustwasm` bare, which resolves to the
//     package's `main` — a CJS IIFE bundle whose named exports come back
//     `undefined` under vite (the same trap `faust-offline.ts` documents and
//     sidesteps with an explicit `dist/esm` subpath import). The config aliases
//     the bare specifier to the ESM entry so the shipped runtime file works
//     unmodified — no test-only branch inside `packages/web`.
//
//  2. `FaustWasmInstantiator.loadDSPFactory(wasmUrl, metaUrl)` fetches. Under
//     ART the `?url` imports resolve to absolute FILESYSTEM paths (see
//     `workletFsUrl()` in vitest.config.ts), and Node's `fetch` cannot take one.
//     The shim below serves those from disk.
//
// ⚠ It ONLY intercepts absolute single-slash paths (`/Users/…`), i.e. exactly
// what the ART `?url` plugin emits. Every other request — including `//host/…`
// and any real URL — falls through to the platform `fetch` untouched, so a
// scenario cannot silently read a file where it meant to reach the network.
// The bytes served are the committed `packages/dsp/dist` bytes: what ships.

import { readFile } from 'node:fs/promises';

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: unknown, init?: unknown) => {
  if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('//')) {
    return new Response(new Uint8Array(await readFile(input)));
  }
  return (realFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
}) as typeof globalThis.fetch;
