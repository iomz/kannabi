import { ValidationError } from '../../../server/identity.js';
import { Gs1Error } from '../toolkit/errors.js';

/** Where a GS1 refusal becomes a Kannabi one.
 *
 * The toolkit refuses with its own error so that it needs nothing of
 * Kannabi's. Everything the adapter hands to core, to a route or to another
 * plugin goes through here, so a value the toolkit will not accept is answered
 * as any other invalid input is. The message is the toolkit's, unchanged.
 */
function translated(error: unknown): unknown {
  return error instanceof Gs1Error ? new ValidationError(error.message, { cause: error }) : error;
}

export function refuse<T>(work: () => T): T {
  try { return work(); } catch (error) { throw translated(error); }
}

export async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw translated(error); }
}
