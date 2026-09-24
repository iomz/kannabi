import { record, ValidationError } from './identity.js';
import { isThemeId, type ThemeId } from '../shared/theme.js';

export type Settings = {
  requirePhoto: boolean;
  displayTimezone: string;
  themeId: ThemeId;
  /** The longest lifetime an API token may be created with, in whole days, or
   * null for no ceiling at all.
   *
   * Null is the unconfigured state rather than a chosen policy, which is why
   * it is also the shipped default: Kannabi has no basis for inventing a
   * number here, and a ceiling means nothing unless an administrator decided
   * it. While it is null a token may be created without an expiry, and a
   * caller must still ask for that explicitly.
   */
  apiTokenMaxLifetimeDays: number | null;
  /** How long a toast stays on screen, in whole seconds.
   *
   * Deployment-wide UI policy rather than an account preference: how long a
   * message needs to be readable depends on the room and the people in it, not
   * on whose account is signed in. It is a fixed lifetime — the toast is shown
   * for this long and then goes — and nothing extends it but the reader's own
   * pointer resting on it.
   */
  toastSeconds: number;
};

/** The shipped lifetime, and the one every existing deployment keeps. */
export const defaultToastSeconds = 5;

/** Below two seconds a message cannot be read before it leaves, and above
 * thirty a toast has stopped being transient — that is a banner, and the thing
 * to reach for is a message that stays until it is dismissed. The bound is a
 * usability range, not a security one. */
export const minToastSeconds = 2;
export const maxToastSeconds = 30;

export function toastSeconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < minToastSeconds || value > maxToastSeconds) {
    throw new ValidationError(
      `${field} must be a whole number of seconds between ${minToastSeconds} and ${maxToastSeconds}`);
  }
  return value;
}

/** The largest ceiling an administrator may configure. It is a sanity bound on
 * the stored value, not a security policy: a hundred years is already
 * indistinguishable from no ceiling, which is expressed as null instead. */
const maxLifetimeDays = 36500;

export function apiTokenLifetimeDays(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maxLifetimeDays) {
    throw new ValidationError(`${field} must be a whole number of days between 1 and ${maxLifetimeDays}`);
  }
  return value;
}

export function validateSettings(value: unknown): Settings {
  const input = record(value, ['requirePhoto', 'displayTimezone', 'themeId', 'apiTokenMaxLifetimeDays',
    'toastSeconds']);
  if (typeof input.requirePhoto !== 'boolean' || typeof input.displayTimezone !== 'string'
      || !isThemeId(input.themeId)) {
    throw new ValidationError('Photo requirement, display timezone, and supported theme are required');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: input.displayTimezone }); }
  catch { throw new ValidationError('Unknown display timezone'); }
  const ceiling = input.apiTokenMaxLifetimeDays === undefined || input.apiTokenMaxLifetimeDays === null
    ? null : apiTokenLifetimeDays(input.apiTokenMaxLifetimeDays, 'apiTokenMaxLifetimeDays');
  return {
    requirePhoto: input.requirePhoto, displayTimezone: input.displayTimezone,
    themeId: input.themeId, apiTokenMaxLifetimeDays: ceiling,
    // Absent means an instance that predates the setting, which is the shipped
    // lifetime rather than an error.
    toastSeconds: input.toastSeconds === undefined || input.toastSeconds === null
      ? defaultToastSeconds : toastSeconds(input.toastSeconds, 'toastSeconds'),
  };
}
/** Kannabi's own date-only presentation.
 *
 * ISO field order with `/` separators, which reads unambiguously for this
 * deployment's users and sorts the way it is written. This is the intended
 * default for a future Admin/Settings date-presentation preference; until that
 * exists it is fixed. It governs only dates Kannabi renders — a native
 * `<input type="date">` stays under browser and locale control.
 *
 * The input is an ISO date or instant and is presented by its date fields as
 * written, without a timezone conversion, so a filter bound displays exactly
 * the day the caller chose.
 */
export function displayDate(isoDate: string): string {
  return isoDate.slice(0, 10).replaceAll('-', '/');
}

export function displayInstant(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, dateStyle: 'medium', timeStyle: 'long',
  }).format(new Date(instant));
}
