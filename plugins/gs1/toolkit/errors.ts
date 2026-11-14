/** A value this toolkit refuses, with the reason as its message.
 *
 * The toolkit's own error, so it depends on nothing outside itself. Whoever
 * embeds the toolkit decides how a refusal is reported: Kannabi's adapter
 * turns it into the validation error its API answers with.
 */
export class Gs1Error extends Error {}

/** A plain object carrying none but the named fields. */
export function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Gs1Error('Expected an object');
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Gs1Error(`Unsupported field: ${key}`);
  }
  return value as Record<string, unknown>;
}
