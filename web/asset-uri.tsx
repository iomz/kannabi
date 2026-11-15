import type { ReactNode } from 'react';
import { CopyField } from './copy-field';
import { HelpTip, SubHeading } from './ui';

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
export function AssetUri({ surfacedUri, nativeUri, showNativeUri, label }: {
  surfacedUri: string; nativeUri: string; showNativeUri: boolean;
  /** What the surfaced address is called, from the plugin that surfaces it. */
  label: Readonly<{ name: string; help: ReactNode }> | null;
}) {
  if (surfacedUri === nativeUri) {
    return showNativeUri
      ? <div className="grid gap-3">
        <SubHeading className="mb-0">Asset URI
          <HelpTip label="About the Asset URI">Kannabi’s stable address for this Asset.
            It never changes.</HelpTip>
        </SubHeading>
        <CopyField id="asset-uri" value={nativeUri} hiddenLabel="Asset URI"
          copyLabel="Copy Asset URI" copiedLabel="Asset URI copied" />
      </div>
      : null;
  }
  // The standing explanation moved behind the heading's own help: what a
  // reader wants here is the address, and what Kannabi does and does not claim
  // about it is worth reading once rather than every visit.
  const name = label?.name ?? 'Surfaced address';
  return <div className="grid gap-3">
    <SubHeading className="mb-0">{name}
      {label && <HelpTip label={'About ' + name}>{label.help}</HelpTip>}
    </SubHeading>
    <CopyField id="asset-uri" value={surfacedUri} hiddenLabel={name + ' URI'}
      copyLabel={'Copy ' + name + ' URI'} copiedLabel={name + ' URI copied'} />
    {showNativeUri && <>
      <SubHeading className="mt-3 mb-0">Kannabi Asset URI
        <HelpTip label="About the Kannabi Asset URI">Kannabi’s stable address for this Asset.
          It never changes and stays valid even if the identifier above is detached.</HelpTip>
      </SubHeading>
      <CopyField id="native-asset-uri" value={nativeUri} hiddenLabel="Kannabi Asset URI"
        copyLabel="Copy Kannabi Asset URI" copiedLabel="Kannabi Asset URI copied" />
    </>}
  </div>;
}
