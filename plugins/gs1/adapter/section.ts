import type { ReporterAttribution } from '../../../server/identity-store.js';
import type { Gs1KeyIssuance } from './store.js';

/** What the GS1 plugin states about one Asset: the values Kannabi issued for
 * it from a managed namespace.
 *
 * It sits under `extensions.gs1` in the Asset representation because issuing
 * is this plugin's act and not core's: core records identifiers and issues
 * none. An issuance stays here after its identifier is detached, since the
 * ledger binds the value to this Asset for good. Storing an identifier is not
 * issuing it, so an identifier absent from this list was recorded, whatever
 * prefix its digits fall inside.
 */
export type Gs1AssetSection = Readonly<{
  issued: readonly Readonly<{ scheme: string; value: string; at: string; by: ReporterAttribution }>[];
}>;

export function issuedSection(issuances: readonly Gs1KeyIssuance[]): Gs1AssetSection {
  return { issued: issuances.map((issuance) => ({ scheme: issuance.scheme, value: issuance.canonical,
    at: issuance.allocatedAt, by: { key: issuance.allocatedBy.key, name: issuance.allocatedBy.name,
      status: issuance.allocatedBy.status } })) };
}
