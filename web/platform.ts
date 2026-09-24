/** How the Asset-search shortcut is written on this machine.
 *
 * The handler already accepts either modifier, so this decides presentation
 * only: showing `⌘K` to somebody holding a Ctrl key is the whole problem being
 * solved. The signal is the platform string rather than any feature test,
 * because nothing about the keyboard is detectable — only the convention.
 */
export function isApplePlatform(hint: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(hint);
}

export function searchShortcutHint(applePlatform: boolean): string {
  return applePlatform ? '⌘K' : 'Ctrl K';
}

/** What assistive technology is told, in the form `aria-keyshortcuts` expects.
 * Both modifiers stay listed because both work; only the visible hint narrows
 * to the one this machine's owner will reach for. */
export const searchKeyShortcuts = 'Meta+K Control+K';

/** Best available platform string, or an empty hint when there is nothing to
 * read. `navigator.platform` is deprecated but remains the only value every
 * engine agrees on, so the modern hint is preferred and it is the fallback. */
export function platformHint(): string {
  if (typeof navigator === 'undefined') return '';
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || navigator.userAgent || '';
}
