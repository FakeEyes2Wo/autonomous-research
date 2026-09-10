import { readFile } from 'node:fs/promises';

// All assets are package-relative and served locally, independent of host port,
// checkout path, operating system and public CDNs.
const fixed = new Map([
  ['/autoresearch', ['workbench.html', 'text/html; charset=utf-8']],
  ['/autoresearch/', ['workbench.html', 'text/html; charset=utf-8']],
  ['/autoresearch/workbench-client.js', ['workbench-client.js', 'text/javascript; charset=utf-8']],
  ['/autoresearch/workbench-sync.js', ['workbench-sync.js', 'text/javascript; charset=utf-8']],
  ['/autoresearch/workbench-chat.js', ['workbench-chat.js', 'text/javascript; charset=utf-8']],
  ['/autoresearch/workbench.css', ['workbench.css', 'text/css; charset=utf-8']],
  ['/autoresearch/workbench-layout.css', ['workbench-layout.css', 'text/css; charset=utf-8']],
  ['/autoresearch/workbench-theme.css', ['workbench-theme.css', 'text/css; charset=utf-8']],
  ['/autoresearch/native-workbench.css', ['native-workbench.css', 'text/css; charset=utf-8']],
  ['/autoresearch/vendor/pdfjs/pdf.mjs', ['vendor/pdfjs/pdf.mjs', 'text/javascript; charset=utf-8']],
  ['/autoresearch/vendor/pdfjs/pdf.worker.mjs', ['vendor/pdfjs/pdf.worker.mjs', 'text/javascript; charset=utf-8']],
]);
const types = { bcmap: 'application/octet-stream', pfb: 'application/octet-stream', ttf: 'font/ttf', wasm: 'application/wasm', js: 'text/javascript; charset=utf-8' };

export function registerWorkbenchAssets(ctx) {
  return ctx.webServer.register({
    kind: 'prefix', path: '/autoresearch',
    async handler(req, res) {
      const hostname = String(req.headers.host || '').replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '::1'].includes(hostname) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) { res.statusCode = 403; return res.end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.setHeader('allow', 'GET, HEAD'); return res.end(); }
      const path = String(req.url || '').split('?', 1)[0];
      let asset = fixed.get(path);
      if (!asset) {
        // A single, tightly constrained filename inside known PDF.js resource
        // folders. No decoding, arbitrary relative paths or filesystem listing.
        const match = path.match(/^\/autoresearch\/vendor\/pdfjs\/(cmaps|standard_fonts|wasm)\/([A-Za-z0-9_-]+\.(bcmap|pfb|ttf|wasm|js))$/);
        if (match) asset = [`vendor/pdfjs/${match[1]}/${match[2]}`, types[match[3]]];
      }
      if (!asset) { res.statusCode = 404; return res.end(); }
      try {
        const bytes = await readFile(new URL(asset[0], import.meta.url));
        res.statusCode = 200;
        res.setHeader('content-type', asset[1]);
        res.setHeader('content-length', bytes.length);
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'same-origin');
        if (asset[0].endsWith('.html')) res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { res.statusCode = 404; res.end(); }
    }
  });
}
