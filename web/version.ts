declare const __KANNABI_VERSION__: string | undefined;

/** The running Kannabi version, substituted at build time from package
 * metadata. Outside a Vite build — a unit test importing this module directly —
 * there is no build to read, so it reports a development marker rather than a
 * version it cannot know. */
export const kannabiVersion: string = typeof __KANNABI_VERSION__ === 'string'
  ? __KANNABI_VERSION__ : 'dev';

/** How a version is written in the interface: one quiet line, prefixed. */
export function displayVersion(version: string): string {
  return 'v' + version;
}
