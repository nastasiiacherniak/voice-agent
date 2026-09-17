/**
 * tokens.ts reaches for the `Buffer` global. esbuild injects this file so that
 * reference resolves to the npm `buffer` package instead of nothing.
 */
export { Buffer } from 'buffer';
