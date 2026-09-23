export type ApiTokenCreateInput = {
  label: string;
  /** Null asks for a token with no expiry, which the instance may refuse. */
  lifetimeDays: number | null;
  admin: boolean;
};

/** Turns the creation form into the request body, or says what is missing.
 *
 * It decides nothing about policy. The instance's ceiling arrives as
 * `maxLifetimeDays` and is only used to keep the form from asking for
 * something the server is certain to refuse; the server remains the authority
 * and re-checks everything.
 *
 * `admin` is dropped unless the person is currently an administrator, so the
 * form can never ask for a capability its owner does not have.
 */
export function apiTokenCreateInput(form: {
  label: string;
  expires: boolean;
  days: string;
  admin: boolean;
  isAdmin: boolean;
  maxLifetimeDays: number | null;
}): { body: ApiTokenCreateInput; error: null } | { body: null; error: string } {
  const label = form.label.trim();
  if (!label) return { body: null, error: 'Give the token a name so you can recognise it later.' };
  if (!form.expires) {
    if (form.maxLifetimeDays !== null) {
      return { body: null, error: `This instance requires a token to expire within ${form.maxLifetimeDays} days.` };
    }
    return { body: { label, lifetimeDays: null, admin: form.isAdmin && form.admin }, error: null };
  }
  const days = Number(form.days.trim());
  if (!form.days.trim() || !Number.isSafeInteger(days) || days < 1) {
    return { body: null, error: 'Enter a whole number of days, or choose that the token never expires.' };
  }
  if (form.maxLifetimeDays !== null && days > form.maxLifetimeDays) {
    return { body: null, error: `This instance allows at most ${form.maxLifetimeDays} days.` };
  }
  return { body: { label, lifetimeDays: days, admin: form.isAdmin && form.admin }, error: null };
}
