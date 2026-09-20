export const demoPassword = 'Kannabi-demo-only-2026!';
export const demoAccounts = [
  { name: 'Alex Demo', email: 'evaluator@demo.invalid' },
  { name: 'Morgan Demo', email: 'collaborator@demo.invalid' },
  { name: 'Robin Demo', email: 'outsider@demo.invalid' },
] as const;
export const demoGroups = ['Demo Workshop', 'Shared Studio', 'Field Kits', 'Private Store'] as const;
export const demoOwners = ['Northstar Demo Cooperative', 'Meadow Demo Rentals', 'Workshop Equipment Pool'] as const;
const products = ['Signal generator', 'RFID reader', 'Field laptop', 'Inspection camera',
  'Tool case', 'Portable projector', 'Survey receiver', 'Trail backpack',
  'Bench multimeter', 'Audio recorder', 'Inspection microscope', 'Workshop tablet'];
const places = ['Bench', 'Studio', 'Field', 'Shelf'];

// Synthetic, checksum-valid values for UI evaluation, not allocated GS1 keys.
const laptopGtin = '00614141123452';
const cameraGtin = '04901234567894';
const palletType = '0614141234561';
const crateType = '0614141234578';
const demoGcp = '0614141';

/** Every Asset falls into one identification pattern, so ordinary demo use
 * shows the whole 0..n model rather than a single shape:
 *
 *   none        an Asset with no GS1 identifier at all — a normal state
 *   gtin        a class-level GTIN only, shared with other Assets of the model
 *   sgtin       a serialised trade item, with its trade-item GTIN alongside
 *   giai        an individually identified fixed asset
 *   both        an SGTIN from the manufacturer and an owner-assigned GIAI
 *   pallet      a serialised GRAI sharing one returnable asset type
 *   crate       a second shared type, tracked at type level only
 */
const patterns = ['none', 'gtin', 'sgtin', 'giai', 'both', 'pallet', 'crate'] as const;

export function demoAssets() {
  return Array.from({ length: 140 }, (_, index) => {
    const serial = 'DEMO-' + String(index + 1).padStart(3, '0');
    const pattern = patterns[index % patterns.length];
    const gtin = index % 2 === 0 ? laptopGtin : cameraGtin;
    const identifiers: unknown[] =
      pattern === 'none' ? []
        : pattern === 'gtin' ? [{ scheme: 'gtin', gtin }]
          : pattern === 'sgtin' ? [{ scheme: 'sgtin', gtin, serial }, { scheme: 'gtin', gtin }]
            : pattern === 'giai' ? [{ scheme: 'giai', assetReference: demoGcp + serial }]
              : pattern === 'both'
                ? [{ scheme: 'sgtin', gtin, serial }, { scheme: 'giai', assetReference: demoGcp + 'A' + serial }]
                : pattern === 'pallet'
                  ? [{ scheme: 'grai', assetType: palletType, serial }]
                  : [{ scheme: 'grai', assetType: crateType }];
    const group = index < 48 ? 0 : index < 88 ? 1 : index < 120 ? 2 : 3;
    const reporter = group === 0 ? 0 : group === 1 ? 1 : group === 2 ? (index % 2) : 2;
    return {
      name: `${products[index % products.length]} · ${places[Math.floor(index / products.length) % places.length]} ${serial.slice(-3)}`,
      identifiers, pattern, group, reporter,
      isPublic: index < 120 ? index % 4 === 0 : index % 5 === 0,
      owner: index % 4 === 0 ? null : index % demoOwners.length,
      photo: index % 3 === 0 ? ['instrument.png', 'camera.png', 'case.png'][Math.floor(index / 3) % 3] : null,
    };
  });
}
export const evaluatorScopes = { all: 124, mine: 64, group: 120, public: 34 };

/** GIAI namespaces, arranged so every allocation UI state is reachable:
 * Demo Workshop manages two, Shared Studio one, and the rest none. */
export const demoNamespaces = [
  { group: 0, gcp: '0614141', exclusions: [{ from: 1, to: 4 }, { from: 9, to: 11 }] },
  { group: 0, gcp: '9521234', exclusions: [] },
  { group: 1, gcp: '0455123', exclusions: [] },
] as const;

/** Assets that receive a Kannabi-issued GIAI from the first namespace.
 * Its exclusions make the issued references 5, 6, 7, 8, 12 — the skips are
 * visible without reading the configuration. Indices are all in Demo Workshop
 * and deliberately mix an Asset that had no identifier at all with one that
 * already carries a manufacturer SGTIN. */
export const demoAllocations = [0, 2, 7, 9, 14] as const;
export const demoAllocatedSequences = [5, 6, 7, 8, 12] as const;
