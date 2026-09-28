// The native Asset URI: an Asset addressed by its own application identity.
// Always valid, for every Asset, and unchanged by any identifier the Asset
// gains or loses, so this is what persistence and internal references use.
//
// It is not the only address. A supported GS1 identity also gives an Asset a
// Digital Link address, built in the GS1 boundary and chosen between by
// `surfaced-uri.ts`. Those are additional ways in, never the identity.
export function assetPath(id: string): string {
  return '/asset/' + id;
}

export function assetPhotoPath(id: string, photoKey: string): string {
  return '/api/assets/' + id + '/photos/' + photoKey;
}
