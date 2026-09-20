// Canonical Asset addressing. An Asset is addressed by its native application
// identity; external identifiers such as SGTIN or GRAI never address an Asset.
export function assetPath(id: string): string {
  return '/asset/' + id;
}

export function assetPhotoPath(id: string, photoKey: string): string {
  return '/api/assets/' + id + '/photos/' + photoKey;
}
