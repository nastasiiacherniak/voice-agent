/**
 * Only `dirname` is reached in the browser, and only to be handed to the
 * no-op mkdirSync above.
 *
 * `npm run build:pages` aliases 'node:path' to this file.
 */
export function dirname(path: string): string {
  const cut = path.replace(/[/\\]+$/, '').lastIndexOf('/');
  return cut <= 0 ? '.' : path.slice(0, cut);
}
export function resolve(...parts: string[]): string {
  return parts.join('/');
}
