/** Where a Kannabi avatar is fetched from, and nowhere else. */
const gravatarOrigin = 'https://gravatar.com/avatar/';

/** Builds the image URL for a Gravatar identifier.
 *
 * Shared because the browser renders the image and the server owns the
 * identifier: only the hashing needs a runtime, and keeping the URL shape in
 * one place stops the two sides disagreeing about what is requested.
 *
 * `d=404` is deliberate. Gravatar's other fallbacks invent a picture — a
 * silhouette, a generated pattern — for somebody who never chose one, and
 * Kannabi already has an honest fallback of its own in the person's initial.
 * Answering 404 lets the interface use it instead of showing a stranger's
 * placeholder as though it were them.
 *
 * `r=g` keeps what Kannabi renders to the rating an inventory tool should
 * display without anybody having asked.
 */
export function gravatarUrl(identifier: string, size: number): string {
  const query = new URLSearchParams({ s: String(size), d: '404', r: 'g' });
  return `${gravatarOrigin}${identifier}?${query}`;
}
