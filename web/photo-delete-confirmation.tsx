import { useEffect, useId, useRef } from 'react';

export function PhotoDeleteConfirmation({ open, busy, error, onClose, onConfirm }: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      queueMicrotask(() => cancel.current?.focus());
    } else if (!open && node.open) node.close();
  }, [open]);

  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby={titleId}
    aria-describedby={descriptionId} onClose={onClose}>
    <div className="confirmation-dialog-card">
      <div className="confirmation-header"><h2 id={titleId}>Delete photo?</h2>
        <button type="button" className="dialog-close" aria-label="Close photo deletion dialog"
          onClick={() => dialog.current?.close()}>×</button></div>
      <div className="confirmation-stage photo-confirmation-stage">
        <p id={descriptionId}>This photo will be permanently removed from this Asset.</p>
        <div className="photo-confirmation-actions">
          <button ref={cancel} type="button" className="photo-confirmation-cancel"
            onClick={() => dialog.current?.close()}>Cancel</button>
          <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
            {busy ? 'Deleting…' : 'Delete photo'}
          </button>
        </div>
        {error && <p className="confirmation-error" role="alert">{error.endsWith('.') ? error : error + '.'}</p>}
      </div>
    </div>
  </dialog>;
}
