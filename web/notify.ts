import { toast } from 'sonner';

/** Kannabi's transient action feedback, through its single Sonner viewport.
 * Durable state, warnings, one-time secrets, and field-specific errors remain
 * beside the content or control they explain. */
export type NotifyOptions = {
  /** Seconds, for the rare caller whose message needs longer than the
   * instance's own policy. Omitted, the instance decides. */
  seconds?: number;
};

/** An explicit duration has to reach two places — Sonner's timer and the
 * remaining-time bar — and they must be given the same number. */
function options({ seconds }: NotifyOptions) {
  if (seconds === undefined) return undefined;
  return {
    duration: seconds * 1000,
    style: { '--kannabi-toast-duration': `${seconds}s` } as React.CSSProperties,
  };
}

export function notify(message: string, settings: NotifyOptions = {}): void {
  toast.success(message, options(settings));
}

export function notifyFailure(message: string, settings: NotifyOptions = {}): void {
  toast.error(message, options(settings));
}
