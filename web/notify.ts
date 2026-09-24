import { toast } from 'sonner';

/** Kannabi's one way to say that something happened.
 *
 * Feedback stays beside the control that caused it wherever that control is
 * still on screen: a `Saved` next to the button that saved is easier to
 * connect than a message somewhere else. A toast is for the other case — when
 * whatever was acted on has gone, or the dialog that asked has closed, so
 * there is nothing left to put the message beside.
 *
 * The abstraction stays this thin on purpose. It names the two kinds Kannabi
 * actually uses and nothing else, so swapping the implementation underneath is
 * a change in one file rather than at every call site.
 */
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
