/**
 * Serves dist/ the way GitHub Pages will, so the static demo can be checked
 * before it is pushed. ES modules and the sql.js .wasm both need http, so
 * opening dist/index.html off the filesystem does not work.
 *
 *   npm run build:pages && npm run preview:pages
 */

import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const port = Number(process.env.PAGES_PORT ?? 8788);

if (!existsSync(dist)) {
  console.error('dist/ is missing - run `npm run build:pages` first');
  process.exit(1);
}

express()
  .use(express.static(dist))
  .listen(port, () => console.log(`pages preview on http://localhost:${port}`));
