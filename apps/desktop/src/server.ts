// Loopback static server for the native shell.
//
// Serves the PT_DESKTOP_BUILD=1 web bundle (adapter-static output) over
// 127.0.0.1 with the same cross-origin-isolation headers production ships via
// packages/web/_headers: COOP same-origin + COEP credentialless (SharedArrayBuffer
// / Faust WASM threads need the isolation; credentialless, NOT require-corp, so
// no-CORP cross-origin media keeps loading — see _headers for the full why).
//
// SPA fallback: /rack (and every other ssr:false route) has no prerendered
// HTML — on Cloudflare Pages the worker renders it; here the adapter-static
// `fallback.html` shell boots the client router instead.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.rff': 'application/octet-stream',
  '.wad': 'application/octet-stream',
  '.data': 'application/octet-stream',
};

function contentType(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve a request path to a file inside webRoot, or null. Tries the exact
 * file, then `<p>.html`, then `<p>/index.html` (matching prerendered output). */
function resolveFile(webRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const base = path.resolve(webRoot);
  const candidates = [
    path.resolve(base, '.' + safe),
    path.resolve(base, '.' + safe + '.html'),
    path.resolve(base, '.' + safe, 'index.html'),
  ];
  for (const c of candidates) {
    // Containment check — no path may escape the web root.
    if (c !== base && !c.startsWith(base + path.sep)) continue;
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export interface StaticServer {
  port: number;
  close: () => Promise<void>;
}

export function startStaticServer(webRoot: string, port: number): Promise<StaticServer> {
  const fallback = path.join(webRoot, 'fallback.html');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Cross-origin isolation on EVERY response (documents need it; keeping it
    // uniform on subresources is harmless and matches the production edge).
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    let filePath = resolveFile(webRoot, url.pathname);

    // SvelteKit server-load data for non-prerendered routes. The root
    // +layout.server.ts (Clerk auth state) makes the client router fetch
    // `<route>/__data.json` on every SPA-fallback navigation; on Cloudflare
    // the worker answers, here nothing would → the router renders its 404
    // page instead of /rack. The prerendered root `__data.json` IS the exact
    // signed-out payload that load produces (nodes: [layout, null] — no
    // +page.server.ts anywhere outside prerendered pages), so serve it for
    // any data request that has no prerendered file. Auth routes (/r/[id],
    // /dashboard) are NOT desktop-shell surfaces; this shim is for the
    // client-rendered rack family only.
    if (!filePath && url.pathname.endsWith('/__data.json')) {
      const rootData = path.join(webRoot, '__data.json');
      if (fs.existsSync(rootData)) filePath = rootData;
    }

    // SPA fallback: no asset matched and the request looks like a navigation
    // (no file extension) → serve the client-router shell with 200.
    if (!filePath && !path.extname(url.pathname) && fs.existsSync(fallback)) {
      filePath = fallback;
    }

    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath)
      .on('error', () => {
        res.destroy();
      })
      .pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback ONLY — never expose the shell's server on the network.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
