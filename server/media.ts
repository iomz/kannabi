import { IdentityStore, type Asset, type ReportAsset, type ReportingContext } from './identity-store.js';
import type { AssetIdentifier } from './identity.js';
import { ValidationError } from './identity.js';
import type { ObjectStorage } from './storage.js';

export const maxPhotoBytes = 10 * 1024 * 1024;
export async function photoBytes(file: File) {
  if (!file.size || file.size > maxPhotoBytes) throw new ValidationError('Photo must be between 1 byte and 10 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const starts = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  const mime = starts(0xff, 0xd8, 0xff) ? 'image/jpeg'
    : starts(137, 80, 78, 71, 13, 10, 26, 10) ? 'image/png'
    : starts(82, 73, 70, 70) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'image/webp' : null;
  if (!mime || file.type !== mime) throw new ValidationError('Use a JPEG, PNG, or WebP photo with matching content type');
  return { bytes, mime };
}
export class MediaService {
  constructor(private readonly store: IdentityStore, private readonly storage: ObjectStorage) {}

  private async upload(file: File, commit: (key: string) => Promise<Asset>) {
    const { bytes, mime } = await photoBytes(file);
    const key = await this.store.reservePhoto(mime, bytes.length);
    try {
      await this.storage.put(key, bytes, mime);
      return await commit(key);
    } catch (error) {
      // Claim only pending uploads: an ambiguous successful DB commit must retain its bytes.
      try { await this.cleanup(key); } catch (cleanupError) { console.error('Photo cleanup pending', cleanupError); }
      throw error;
    }
  }
  async report(input: ReportAsset, context: ReportingContext, file?: File) {
    if (!file) return this.store.reportAsset(input, context);
    if (!(await this.store.listGroups(context.actorKey)).some((g) => g.key === context.groupKey)) {
      throw new ValidationError('Reporting Group access required');
    }
    return this.upload(file, (key) => this.store.reportAsset(input, context, key));
  }
  async add(identifier: AssetIdentifier, actorKey: string, file: File) {
    await this.store.assertCanEdit(identifier, actorKey);
    return this.upload(file, (key) => this.store.attachPhoto(identifier, actorKey, key));
  }
  async read(identifier: AssetIdentifier, key: string, actorKey: string | null) {
    const photo = await this.store.getPhoto(identifier, key, actorKey);
    return { photo, bytes: await this.storage.get(key) };
  }
  async remove(identifier: AssetIdentifier, actorKey: string, key: string) {
    await this.store.beginPhotoDeletion(identifier, actorKey, key);
    try { await this.cleanup(key); }
    catch (error) { console.error('Photo cleanup pending', error); }
  }
  async cleanup(key?: string) {
    for (const pending of await this.store.claimPhotoCleanup(key)) {
      await this.storage.delete(pending);
      await this.store.finishPhotoCleanup(pending);
    }
  }
}
