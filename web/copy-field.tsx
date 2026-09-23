import { useEffect, useRef, useState } from 'react';
import { Icon } from './icon';

/** A read-only value with the copy affordance inside the field.
 *
 * Extracted from the Asset URI control so anything Kannabi asks a person to
 * take away — a URI, a credential — is copied the same way, rather than each
 * place inventing its own button.
 */
export function CopyField({ id, value, label, copyLabel, copiedLabel, className }: {
  id: string;
  value: string;
  /** Visible label, or omitted when the surrounding context already names it. */
  label?: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (reset.current) clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return <div className={className ? 'copy-field ' + className : 'copy-field'}>
    {label ? <label htmlFor={id}>{label}</label> : null}
    <div className="asset-uri-control">
      <input id={id} value={value} readOnly title={value} spellCheck={false} autoComplete="off"
        onFocus={(event) => event.currentTarget.select()} />
      <button type="button" onClick={() => void copy()}
        aria-label={copied ? copiedLabel : copyLabel} title={copied ? 'Copied' : copyLabel}>
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{copied ? copiedLabel : ''}</span>
  </div>;
}
