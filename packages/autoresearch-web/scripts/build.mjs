import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(source, dist, { recursive: true });
// Keep a single DSH lazy factory: the host applies this package once. The native
// bridge is a source module for testing and is inlined into that factory here.
const nativeBridge = (await readFile(resolve(source, 'native-workbench-client.js'), 'utf8')).replace(/^export /gm, '');
const client = await readFile(resolve(source, 'client.js'), 'utf8');
const marker = "    const React = require('react');";
if (!client.includes(marker)) throw new Error('DSH client factory insertion point is missing');
await writeFile(resolve(dist, 'client.js'), client.replace(marker, `${nativeBridge}\n${marker}`));
const require = createRequire(import.meta.url);
const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
const vendor = resolve(dist, 'vendor/pdfjs');
await mkdir(vendor, { recursive: true });
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) await cp(resolve(pdfjs, 'build', file), resolve(vendor, file));
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await cp(resolve(pdfjs, folder), resolve(vendor, folder), { recursive: true });
await cp(resolve(pdfjs, 'LICENSE'), resolve(vendor, 'LICENSE'));
console.log(`built @athena/autoresearch-web -> ${dist}`);
