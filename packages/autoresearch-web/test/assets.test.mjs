import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWorkbenchAssets } from '../src/workbench-assets.js';

function setup() {
  let route;
  const dispose = registerWorkbenchAssets({ webServer: { register(value) { route = value; return () => { route = null; }; } } });
  return { dispose, request: async (url, overrides = {}) => {
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
    await route.handler({ method: 'GET', url, headers: { host: '127.0.0.1:8080' }, socket: { remoteAddress: '127.0.0.1' }, ...overrides }, res);
    return res;
  } };
}

test('workbench page and links are same-origin, with bounded local assets', async () => {
  const app = setup();
  const page = await app.request('/autoresearch/?projectId=example');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  const text = page.body.toString();
  assert.match(text, /id="back-dsh"[^>]+href="\/"/);
  assert.match(text, /aria-label="LaTeX 编辑区"/);
  assert.match(text, /aria-label="PDF 预览区"/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.equal((await app.request('/autoresearch/workbench-client.js')).statusCode, 200);
  assert.equal((await app.request('/autoresearch/workbench.css', { method: 'HEAD' })).body, undefined);
  app.dispose();
});

test('assets reject traversal, remote hosts, writes and directory reads', async () => {
  const app = setup();
  for (const path of ['/autoresearch/../package.json', '/autoresearch/vendor/pdfjs/cmaps/../../index.js', '/autoresearch/vendor/pdfjs/cmaps/%2e%2e%2findex.js', '/autoresearch/vendor/pdfjs/', '/autoresearching']) {
    assert.equal((await app.request(path)).statusCode, 404, path);
  }
  assert.equal((await app.request('/autoresearch/', { headers: { host: 'evil.example' } })).statusCode, 403);
  assert.equal((await app.request('/autoresearch/', { socket: { remoteAddress: '192.0.2.1' } })).statusCode, 403);
  assert.equal((await app.request('/autoresearch/', { method: 'POST' })).statusCode, 405);
  app.dispose();
});
