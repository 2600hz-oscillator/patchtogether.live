// The RACKSPACE canvas at /r/[id].
//
// ⚠ THIS FILE DID NOT EXIST, AND THAT WAS THE BUG (#2088). `/rack` — the SAME
// app, mounting the SAME `<Canvas>` — has carried `ssr = false` since it moved
// off `/`, with the rationale that the canvas "needs AudioContext,
// AudioWorklet, SharedArrayBuffer, and other browser-only APIs. SSR adds no
// value here and would break imports of browser-only DSP runtimes." Every word
// of that is true of this route too; it simply never got the flag, so it has
// been server-rendering a browser-only component by default.
//
// ⚠ AND IT ONLY EVER WORKED BY ACCIDENT OF BUNDLING. `scripts/prove-ssr-identical.sh`
// records the mechanism in its own header: `Canvas.js` does
// `import { FaustMonoAudioWorkletNode } from '@grame/faustwasm'`, and under
// Node's strict ESM resolution that package provides no such named export, so
// "any Node-hosted SSR of a Canvas route is therefore a 500". Production
// survives only because wrangler esbuild-BUNDLES the Worker and esbuild's CJS
// interop resolves the same specifier. A route whose server render depends on
// which bundler happens to host it is not deliberately server-rendered.
//
// SIZE IS THE CONSEQUENCE, NOT THE REASON. Because this node was the one
// server-reachable importer of `<Canvas>`, the SSR graph carried the entire
// browser render graph into the deployed Worker — `chunks/Canvas.js` at
// 5877 KiB raw, dragging `milkdrop-preset-converter`, `module-docs.generated.js`,
// `@webamp/butterchurn`, `@grame/faustwasm` and mediabunny behind it. That is
// what put the Worker 177 KiB over Cloudflare's 3 MiB ceiling and turned every
// deploy red.
//
// ⚠ `ssr = false` ALONE DOES NOT SHRINK ANYTHING — SvelteKit still lists this
// node in the server manifest, so the component is still bundled (vite.config.ts
// says so in those words). What this flag buys is the CORRECTNESS precondition:
// with no route server-rendering `<Canvas>`, the SSR-build stub in
// `ssrDropBrowserOnlyGraph()` cannot change any server HTML, because there is
// no server HTML for it to change. The flag makes the stub safe; the stub does
// the shrinking.
//
// The server `load` in `+page.server.ts` is UNAFFECTED — `ssr = false` disables
// server RENDERING, not server load functions, so the rackspace lookup, its
// 404s and its auth checks all still run on the server exactly as before.
export const ssr = false;
export const csr = true;
export const prerender = false;
