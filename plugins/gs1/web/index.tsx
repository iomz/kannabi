import type { WebPlugin } from '../../../web/plugin';
import { digitalLinkPath } from '../toolkit/digital-link.js';
import {
  identifierSchemes, isGs1Scheme, schemeDescriptions, schemeInputs, schemeLabels, schemeReference,
} from '../toolkit/gs1.js';
import { preferredDigitalLinkIdentifier } from '../adapter/surfaced-uri.js';
import { unwrap } from '../../../web/api';
import { Gs1AdminSettings } from './admin-settings';
import { GroupPrefixSummary, loadGroupPrefixes } from './group-overview';
import { gs1Api } from './api';
import { gs1AssetPage } from './asset-page';

/** The GS1 plugin's part of the web client.
 *
 * Everything GS1 a person sees comes through here: how its four schemes are
 * named and filled in, which Digital Link addresses an Asset has, and the
 * screens for issuing keys, managing prefixes and the GTIN consistency
 * policy. A web client built without this module shows none of it and lacks
 * nothing.
 */
export const gs1Web: WebPlugin = {
  id: 'gs1',
  // What an SGTIN or a GIAI is belongs to GS1, so each scheme's name links to
  // GS1's own reference for the Application Identifier that distinguishes it
  // rather than to a Kannabi paraphrase of a standard Kannabi does not own.
  schemes: identifierSchemes.map((id) => ({
    id, label: schemeLabels[id], description: schemeDescriptions[id], inputs: schemeInputs[id],
    reference: { href: schemeReference[id], label: 'GS1 reference' },
    policyLabel: 'GS1 policy', addressLabel: 'GS1 Digital Link',
  })),
  // A Digital Link is GS1's, and only an individual-level identity has one
  // Kannabi dereferences: a class-level address denotes a trade item or an
  // asset type, not this Asset.
  addresses: (asset) => asset.identifiers
    .filter((identifier) => identifier.level === 'individual' && isGs1Scheme(identifier.scheme))
    .map((identifier) => digitalLinkPath(identifier)),
  surfaced(asset) {
    const preferred = preferredDigitalLinkIdentifier(asset.identifiers);
    return preferred ? digitalLinkPath(preferred) : null;
  },
  // Neither address is described as canonical. The Digital Link standard
  // reserves that word for the `id.gs1.org` form, which Kannabi does not emit.
  surfacedLabel: {
    name: 'GS1 Digital Link',
    help: <>Kannabi resolves this URI to this Asset.
      Canonical GS1 Digital Link URIs use the <code>id.gs1.org</code> domain.</>,
  },
  assetPage: gs1AssetPage,
  group: {
    view: { path: 'prefixes', label: 'GS1 prefixes' },
    overview: { label: 'GS1 Company Prefixes', load: loadGroupPrefixes, Summary: GroupPrefixSummary },
  },
  adminSettings: {
    load: async () => (await unwrap(await gs1Api.settings.$get())).settings,
    Section: Gs1AdminSettings,
  },
};
