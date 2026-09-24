export const demoPassword = 'Kannabi-demo-only-2026!';

/** A cast chosen so the User directory's visibility rule can be read off the
 * screen rather than taken on trust. Every name is invented.
 *
 * Between them they cover each way a person becomes discoverable and the ways
 * they do not: somebody sharing one Group, somebody sharing two, somebody in
 * no shared Group who is nonetheless known through a public Asset they
 * reported, somebody in a Group of their own who is known to nobody, members
 * who have reported nothing, a second administrator, and two accounts that
 * turned Gravatar on.
 */
export const demoAccounts = [
  { name: 'Alex Demo', email: 'evaluator@demo.invalid' },
  { name: 'Morgan Demo', email: 'collaborator@demo.invalid' },
  { name: 'Robin Demo', email: 'outsider@demo.invalid' },
  { name: 'Devon Demo', email: 'workshop@demo.invalid' },
  { name: 'Kai Demo', email: 'studio@demo.invalid' },
  { name: 'Noa Demo', email: 'store@demo.invalid' },
  { name: 'Sam Demo', email: 'quiet@demo.invalid' },
  { name: 'Rin Demo', email: 'fieldwork@demo.invalid' },
  { name: 'Jules Demo', email: 'bench@demo.invalid' },
  { name: 'Ash Demo', email: 'steward@demo.invalid' },
] as const;

/** Administration is a system role and grants no Asset access; a second one
 * exists so administrator behaviour is not confused with being account zero. */
export const demoAdministrators = [0, 9] as const;

/** Consent, not a setting somebody else chose for them. */
export const demoGravatarAccounts = [3, 7] as const;

export const demoGroups = ['Demo Workshop', 'Shared Studio', 'Field Kits', 'Private Store', 'Quiet Room'] as const;

/** Who belongs to each Group, by account index. The first listed creates it.
 *
 * Kai is in both of Morgan's Groups, so sharing several is distinguishable
 * from sharing one. Sam is alone in a Group nobody else joins, which is what
 * makes them undiscoverable to everybody but an administrator. Devon, Jules
 * and Ash share a Group and have reported nothing, so membership alone is
 * visibly enough. */
export const demoGroupMembers: readonly (readonly number[])[] = [
  [0, 3, 8, 9],
  [1, 0, 4],
  [0, 1, 4, 7],
  [2, 5],
  [6],
];
export const demoOwners = ['Northstar Demo Cooperative', 'Meadow Demo Rentals', 'Workshop Equipment Pool'] as const;
/** Each product names the bundled illustration that suits it, so searching a
 * category such as `camera` returns Assets whose photos match their names.
 * Only the existing three illustrations are used; none were added.
 *
 * Order matters. Photos are attached on every third Asset, and the product
 * cycles every twelfth, so only slots 0, 3, 6 and 9 ever carry one. Those four
 * slots are arranged to cover all three illustrations; moving a product
 * between them silently drops an illustration from the demo entirely. */
const products = [
  { name: 'Signal generator', photo: 'instrument.png' },
  { name: 'RFID reader', photo: 'instrument.png' },
  { name: 'Field laptop', photo: 'case.png' },
  { name: 'Inspection camera', photo: 'camera.png' },
  { name: 'Audio recorder', photo: 'instrument.png' },
  { name: 'Portable projector', photo: 'camera.png' },
  { name: 'Survey receiver', photo: 'instrument.png' },
  { name: 'Trail backpack', photo: 'case.png' },
  { name: 'Bench multimeter', photo: 'instrument.png' },
  { name: 'Tool case', photo: 'case.png' },
  { name: 'Inspection microscope', photo: 'camera.png' },
  { name: 'Workshop tablet', photo: 'case.png' },
] as const;
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

/** Reported days, spread so ordering by `reportedAt` is visibly different from
 * ordering by name.
 *
 * The window is 91 days ending well before any plausible demo run, and the
 * stride is coprime with it, so the first 91 Assets each take a distinct day
 * and the remaining 49 land on days already used. That gives both many distinct
 * timestamps and many exact duplicates, so the `(reportedAt, Asset.id)`
 * tiebreaker is still exercised by ordinary demo browsing.
 *
 * Every Asset is stamped at midnight UTC, deliberately: a duplicate must be an
 * exact duplicate. Chronology lives only here — `Asset.id` is a UUIDv7 whose
 * timestamp carries no domain meaning and is never read as one.
 */
const reportedWindow = 91;
const reportedFirstDay = Date.UTC(2026, 5, 22);
export function demoReportedAt(index: number): string {
  return new Date(reportedFirstDay + ((index * 23) % reportedWindow) * 86400000).toISOString();
}

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
    // A reporter is always a member of the Group they report into. Kai and Noa
    // take a share of Shared Studio and Private Store so that reporting, and
    // therefore being known through one's work, is spread beyond the first
    // three accounts. Demo Workshop stays entirely Alex's, which keeps the
    // evaluator's own counts the ones the demo has always printed.
    const reporter = group === 0 ? 0
      : group === 1 ? (index % 3 === 0 ? 4 : 1)
        : group === 2 ? (index % 2)
          : (index % 2 === 0 ? 5 : 2);
    return {
      name: `${products[index % products.length].name} · ${places[Math.floor(index / products.length) % places.length]} ${serial.slice(-3)}`,
      identifiers, pattern, group, reporter, reportedAt: demoReportedAt(index),
      isPublic: index < 120 ? index % 4 === 0 : index % 5 === 0,
      owner: index % 4 === 0 ? null : index % demoOwners.length,
      // Same photo coverage as before; only which illustration is chosen changed.
      photo: index % 3 === 0 ? products[index % products.length].photo : null,
    };
  });
}
export const evaluatorScopes = { all: 124, mine: 64, group: 120, public: 34 };

/** What one account can see, derived from the same fixture the seed plants, so
 * a change to memberships or reporters cannot leave an expectation stale. */
export function demoScopes(account: number) {
  const groups = demoGroupMembers.flatMap((members, group) => (members.includes(account) ? [group] : []));
  const assets = demoAssets();
  const readable = assets.filter((asset) => asset.isPublic || groups.includes(asset.group));
  return {
    all: readable.length,
    mine: readable.filter((asset) => asset.reporter === account).length,
    group: assets.filter((asset) => groups.includes(asset.group)).length,
    public: assets.filter((asset) => asset.isPublic).length,
  };
}

/** Who each account may know exists, by the one discoverability rule: yourself,
 * anybody for an administrator, anybody sharing a Group, and anybody whose
 * reported Asset you can read. Stated here independently of the Cypher that
 * implements it, so the two can be held against each other. */
export function demoDiscoverable(viewer: number): number[] {
  if ((demoAdministrators as readonly number[]).includes(viewer)) {
    return demoAccounts.map((_, index) => index);
  }
  const groups = demoGroupMembers.flatMap((members, group) => (members.includes(viewer) ? [group] : []));
  const reporters = new Set(demoAssets()
    .filter((asset) => asset.isPublic || groups.includes(asset.group))
    .map((asset) => asset.reporter));
  const shares = new Set(demoGroupMembers
    .filter((members) => members.includes(viewer))
    .flatMap((members) => [...members]));
  return demoAccounts.flatMap((_, index) =>
    (index === viewer || shares.has(index) || reporters.has(index) ? [index] : []));
}

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
