import { CopyField } from './copy-field';

type ClipboardWriter = Pick<Clipboard, 'writeText'>;

export function copyAssetUri(uri: string, clipboard: ClipboardWriter): Promise<void> {
  return clipboard.writeText(uri);
}

export function AssetUri({ uri }: { uri: string }) {
  return <CopyField className="asset-uri" id="asset-uri" value={uri} label="Asset URI"
    copyLabel="Copy Asset URI" copiedLabel="Asset URI copied" />;
}
