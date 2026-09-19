import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon';

type ClipboardWriter = Pick<Clipboard, 'writeText'>;

export function copyAssetUri(uri: string, clipboard: ClipboardWriter): Promise<void> {
  return clipboard.writeText(uri);
}

export function AssetUri({ uri }: { uri: string }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);

  async function copy() {
    try {
      await copyAssetUri(uri, navigator.clipboard);
      setCopied(true);
      if (reset.current) clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return <div className="asset-uri">
    <label htmlFor="asset-uri">Asset URI</label>
    <div className="asset-uri-control">
      <input id="asset-uri" value={uri} readOnly title={uri} />
      <button type="button" onClick={() => void copy()}
        aria-label={copied ? 'Asset URI copied' : 'Copy Asset URI'} title={copied ? 'Copied' : 'Copy Asset URI'}>
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{copied ? 'Asset URI copied' : ''}</span>
  </div>;
}
