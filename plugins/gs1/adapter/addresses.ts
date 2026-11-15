import type { AddressClaim, AddressResolver } from '../../../server/plugin.js';
import { Gs1Error } from '../toolkit/errors.js';
import { digitalLinkPath, parseDigitalLinkPath } from '../toolkit/digital-link.js';
import { preferredDigitalLinkIdentifier } from './surfaced-uri.js';

/** The root-level paths the GS1 plugin claims: the GS1 Digital Link forms
 * Kannabi supports.
 *
 * That is Digital Link dereferencing, not GS1-Conformant Resolver behaviour:
 * Kannabi publishes no resolver description file, declares no supported
 * primary keys, and answers no linkset. Nothing here may be described as
 * conformant resolution.
 *
 * This says which identifier a path names and nothing more. Whether the
 * reader may see the Asset carrying it is core's decision, so an Asset the
 * reader may not see is indistinguishable from an unknown identifier. Each
 * supported form resolves on its own, and none is redirected to another:
 * preference governs presentation, and each form is an independent
 * standards-defined entry point to the same referent.
 */
const notFound: AddressClaim = Object.freeze({ kind: 'notFound' as const });

export const gs1Addresses: AddressResolver = Object.freeze({
  claim(rawPath: string): AddressClaim | null {
    let address;
    try {
      address = parseDigitalLinkPath(rawPath);
    } catch (error) {
      if (error instanceof Gs1Error) return Object.freeze({ kind: 'invalid' as const, message: error.message });
      throw error;
    }
    if (address === null) return null;
    // A well-formed address for a GS1 primary key Kannabi does not model. The
    // numeric path space belongs to Digital Link, so this is an address Kannabi
    // does not serve rather than an unrecognised application route.
    if (address.kind === 'unsupported') return notFound;
    // A class-level identifier describes a trade item or an asset type, not an
    // Asset, so there is no single Asset for Kannabi to serve here. Whether a
    // GTIN becomes a Kannabi referent in its own right is #50's decision, and
    // answering with a list now would settle it by accident.
    if (address.identifier.level !== 'individual') return notFound;
    return Object.freeze({ kind: 'identifier' as const, identifier: address.identifier });
  },
  /** The preferred Digital Link of an Asset that has one. Kannabi presentation
   * policy, never identity: the native Asset URI stays valid, and detaching
   * the preferred identifier changes what is surfaced and nothing else. */
  surfaced(asset) {
    const preferred = preferredDigitalLinkIdentifier(asset.identifiers);
    return preferred ? digitalLinkPath(preferred) : null;
  },
});
