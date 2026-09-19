import { useEffect, useState } from 'react';

export const transientSuccessDuration = 3000;

export function TransientSuccess({ trigger, label }: { trigger: unknown; label: string }) {
  const [generation, setGeneration] = useState<number | null>(null);
  useEffect(() => {
    if (!trigger) {
      setGeneration(null);
      return;
    }
    setGeneration((current) => (current ?? 0) + 1);
    const timeout = setTimeout(() => setGeneration(null), transientSuccessDuration);
    return () => clearTimeout(timeout);
  }, [trigger]);
  return generation === null ? null : <span key={generation} className="settings-status-pill saved transient-success">
    <span aria-hidden="true">✓</span> {label}
  </span>;
}
