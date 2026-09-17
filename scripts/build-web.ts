/**
 * Bundles the one React island on the page - the `border-beam` and `voice-glow`
 * beams around the composer - into src/web/vendor/composer-beams.js, which the
 * page loads as a plain ES module. Everything else in src/web ships unbundled, as written.
 *
 * It runs from `prestart` and `predev`, so a clone never has to know about it.
 */

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const out = await build({
  entryPoints: [resolve(root, 'src/web/composer-beams.entry.jsx')],
  outfile: resolve(root, 'src/web/vendor/composer-beams.js'),
  bundle: true,
  format: 'esm',
  jsx: 'automatic',
  minify: true,
  target: ['chrome111', 'edge111', 'firefox128', 'safari16'],
  // Without this React resolves to its development build, which is twice the
  // size and warns about `process` in a browser that has none.
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
});

const bytes = Object.values(out.metafile.outputs)[0]?.bytes ?? 0;
console.log(`composer-beams.js  ${(bytes / 1024).toFixed(1)} kB`);
