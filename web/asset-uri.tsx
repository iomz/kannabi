import { CopyField } from './copy-field';
import { Hint } from './ui';

type ClipboardWriter = Pick<Clipboard, 'writeText'>;

export function copyAssetUri(uri: string, clipboard: ClipboardWriter): Promise<void> {
  return clipboard.writeText(uri);
}

/** The Asset's addresses.
 *
 * The surfaced URI comes first because it is the one to take away. When the
 * Asset has an eligible GS1 identity that is its Digital Link URI.
 *
 * The native Kannabi URI follows the instance's "Show Kannabi ID" setting,
 * because it is the UUIDv7 spelled as a URL: a deployment that has chosen not
 * to put that reference in front of people has not chosen to put it in front
 * of them one line further down. Hiding it is presentation only — the address
 * stays valid, keeps resolving, and remains what every internal reference and
 * the API use.
 *
 * Neither is described as canonical. The Digital Link standard reserves that
 * word for the `id.gs1.org` form, which Kannabi does not emit.
 */
export function AssetUri({ surfacedUri, nativeUri, showNativeUri }: {
  surfacedUri: string; nativeUri: string; showNativeUri: boolean;
}) {
  if (surfacedUri === nativeUri) {
    return showNativeUri
      ? <CopyField className="mt-5" id="asset-uri" value={nativeUri} label="Asset URI"
        copyLabel="Copy Asset URI" copiedLabel="Asset URI copied" />
      : null;
  }
  return <div className="mt-5 grid gap-3">
    <CopyField id="asset-uri" value={surfacedUri} label="GS1 Digital Link URI"
      copyLabel="Copy GS1 Digital Link URI" copiedLabel="GS1 Digital Link URI copied" />
    <Hint className="mb-0">Derived from this Asset’s GS1 identity. Kannabi resolves it to this Asset;
      it is not a canonical GS1 Digital Link URI, which the standard reserves for <code>id.gs1.org</code>.</Hint>
    {showNativeUri && <>
      <CopyField id="native-asset-uri" value={nativeUri} label="Kannabi Asset URI"
        copyLabel="Copy Kannabi Asset URI" copiedLabel="Kannabi Asset URI copied" />
      <Hint className="mb-0">Kannabi’s stable address for this Asset. It never changes and stays valid
        even if the identifier above is detached.</Hint>
    </>}
  </div>;
}
