import { toast } from '@/components/ui/toast';

/** Kannabi's one way to say that something happened.
 *
 * Feedback stays beside the control that caused it wherever that control is
 * still on screen: a `Saved` next to the button that saved is easier to
 * connect than a message somewhere else. A toast is for the other case — when
 * whatever was acted on has gone, or the dialog that asked has closed, so
 * there is nothing left to put the message beside.
 *
 * The abstraction stays this thin on purpose. It names the two tones Kannabi
 * actually uses and nothing else, so swapping the implementation underneath is
 * a change in one file rather than at every call site.
 */
export function notify(message: string): void {
  toast.add({ title: message, type: 'success' });
}

export function notifyFailure(message: string): void {
  toast.add({ title: message, type: 'error' });
}
