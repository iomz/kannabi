import type { WebPlugin } from '../web/plugin';

/** The web counterpart of `test-fixture.ts`: the screens of the fixture plugin
 * core's tests run against. It presents the two fixture schemes and one
 * address form, and takes none of the page slots, so a core screen under test
 * shows what core renders and nothing a real plugin would add. */
export const shelfWeb: WebPlugin = {
  id: 'shelf',
  schemes: [
    { id: 'tag', label: 'Shelf tag', description: 'A label stuck to one thing.',
      inputs: [{ name: 'code', label: 'Code', required: true }],
      reference: { href: 'https://shelf.example/tag', label: 'Shelf reference' } },
    { id: 'model', label: 'Model', description: 'Describes many Assets.',
      inputs: [{ name: 'series', label: 'Series', required: true }] },
  ],
  addresses: (asset) => asset.identifiers.filter((identifier) => identifier.scheme === 'tag')
    .map((identifier) => `/tag/${identifier.components.code}`),
  surfaced(asset) {
    const tag = asset.identifiers.find((identifier) => identifier.scheme === 'tag');
    return tag ? `/tag/${tag.components.code}` : null;
  },
  surfacedLabel: { name: 'Shelf tag address', help: 'Kannabi resolves this address to this Asset.' },
  // One way to add an identifier beside recording an existing one, so the
  // slot core offers a plugin is exercised. It is never submitted to a server.
  assetPage: {
    load: async () => ({}),
    add: {
      label: 'Print new',
      Panel: () => <p>Print a shelf tag for this Asset. <button type="submit">Print</button></p>,
      submit: async (assetId) => ({ asset: { id: assetId, identifiers: [] }, added: null }),
      done: 'Tag printed',
      failed: 'Could not print a tag',
    },
  },
};

export const plugins: readonly WebPlugin[] = [shelfWeb];
