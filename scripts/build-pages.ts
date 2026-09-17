/**
 * Builds the static GitHub Pages demo into dist/.
 *
 * Pages serves files, not processes, so the server has to come along inside
 * the page: src/browser/demo.ts runs the same `Session` against the same SQL,
 * with sql.js standing in for better-sqlite3 and small shims standing in for
 * the handful of node: imports underneath it. See src/browser/shims/.
 *
 * The aliases below are the entire substitution. Nothing in src/booking,
 * src/agent or src/web is forked for the browser; app.js takes one branch.
 */

import { build, type BuildOptions, type Plugin } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, 'src/web');
const dist = resolve(root, 'dist');
const shims = resolve(root, 'src/browser/shims');

const shared: BuildOptions = {
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['chrome111', 'edge111', 'firefox128', 'safari16'],
  define: { 'process.env.NODE_ENV': '"production"' },
};

/**
 * pipeline.ts imports AnthropicDriver at module scope. Left alone that drags
 * the whole SDK into a static page for a driver the demo can never run, so the
 * import is pointed at a stub.
 */
const stubLlm: Plugin = {
  name: 'stub-llm',
  setup(b) {
    b.onResolve({ filter: /agent\/llm\.js$/ }, () => ({ path: resolve(shims, 'llm.ts') }));
  },
};

await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'vendor'), { recursive: true });

// -------------------------------------------------- the server, for the page
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/browser/demo.ts')],
  outfile: resolve(dist, 'demo.js'),
  plugins: [stubLlm],
  alias: {
    'better-sqlite3': resolve(shims, 'sqlite.ts'),
    'node:crypto': resolve(shims, 'crypto.ts'),
    'node:fs': resolve(shims, 'node-fs.ts'),
    'node:path': resolve(shims, 'node-path.ts'),
  },
  // tokens.ts reaches for the Buffer global.
  inject: [resolve(shims, 'buffer-global.ts')],
});

// ------------------------------------------------------ the composer's beams
await build({
  ...shared,
  entryPoints: [resolve(web, 'composer-beams.entry.jsx')],
  outfile: resolve(dist, 'vendor/composer-beams.js'),
  jsx: 'automatic',
});

// ------------------------------------------------------------------- statics
for (const file of ['styles.css', 'app.js', 'echo.js', 'vad.js', 'brand-mark.svg']) {
  await cp(resolve(web, file), resolve(dist, file));
}

// The recorder writes WAVs back to disk over an API that does not exist here.
const html = await readFile(resolve(web, 'index.html'), 'utf8');
const APP_TAG = '<script type="module" src="app.js"></script>';
if (!html.includes(APP_TAG)) throw new Error('index.html: app.js script tag not found');
await writeFile(
  resolve(dist, 'index.html'),
  html.replace(APP_TAG, `<script type="module" src="demo.js"></script>\n    ${APP_TAG}`),
);

await cp(resolve(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), resolve(dist, 'sql-wasm.wasm'));

// Stops Pages running the output through Jekyll.
await writeFile(resolve(dist, '.nojekyll'), '');

console.log(`dist/ built - open it over http, not file://, or the modules will not load`);
