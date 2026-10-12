import { record, ValidationError } from './identity.js';
import { isThemeId, type ThemeId } from '../shared/theme.js';

export const peopleDirectories = ['everyone', 'names', 'shared'] as const;
export type PeopleDirectory = (typeof peopleDirectories)[number];

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
  /** Show Kannabi's native Asset locator on ordinary Asset pages. */
  showAssetId: boolean;
  /** Show the accepting GS1 policy stamp beside recorded identifiers. */
  showIdentifierPolicyVersion: boolean;
  /** Refuse an identifier whose AI 01 disagrees with one the Asset already
   * carries. On by default, and every instance that predates the setting keeps
   * it on.
   *
   * An acceptance policy for subsequent writes and nothing more. Turning it off
   * lets an instance record conflicting GTINs it was told about — a migration
   * from a source that wrote its own numbering in SGTIN syntax, say — and leaves
   * the conflict visible; it never declares that one Asset is two trade items.
   * Turning it back on is refused while any Asset still holds a conflict, and
   * removes nothing to make it succeed. Syntax, check digits,
   * uniqueness and the same-identifier-twice rule do not depend on it. */
  enforceGtinConsistency: boolean;
  /** Who a signed-in person can find in the People directory, and
   * whether they see email addresses there.
   *
   * `everyone`: every active person, with names and email addresses.
   * `names`: every active person, by name only; addresses stay with their
   * owner and with administration.
   * `shared`: only people who share a Group with the viewer, with addresses.
   *
   * It decides who is discoverable and what is shown about them, never Group
   * membership: which Groups somebody belongs to is shown only where the
   * viewer belongs too. Anonymous visitors never reach it.
   */
  peopleDirectory: PeopleDirectory;
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

/** What a new instance starts with: the one place a default is decided. They
 * are written when the instance's settings are created, and read back as
 * stored. */
export const defaultSettings: Settings = Object.freeze({
  requirePhoto: false, displayTimezone: 'UTC', themeId: 'default', apiTokenMaxLifetimeDays: null,
  toastSeconds: defaultToastSeconds, showAssetId: false, showIdentifierPolicyVersion: false, enforceGtinConsistency: true,
  peopleDirectory: 'everyone',
}) as Settings;

const booleanSettings = ['requirePhoto', 'showAssetId', 'showIdentifierPolicyVersion', 'enforceGtinConsistency'] as const;

/** A change to some settings: each field present is validated, and each field
 * absent is left as it is. Omission never resets, widens or narrows anything,
 * so a client that does not know a setting cannot change it by accident. */
export function validateSettingsChange(value: unknown): Partial<Settings> {
  const input = record(value, [...booleanSettings, 'displayTimezone', 'themeId', 'apiTokenMaxLifetimeDays',
    'toastSeconds', 'peopleDirectory']);
  const change: Partial<Settings> = {};
  for (const name of booleanSettings) {
    if (input[name] === undefined) continue;
    if (typeof input[name] !== 'boolean') throw new ValidationError(`${name} must be true or false`);
    change[name] = input[name];
  }
  if (input.displayTimezone !== undefined) {
    if (typeof input.displayTimezone !== 'string') throw new ValidationError('Unknown display timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: input.displayTimezone }); }
    catch { throw new ValidationError('Unknown display timezone'); }
    change.displayTimezone = input.displayTimezone;
  }
  if (input.themeId !== undefined) {
    if (!isThemeId(input.themeId)) throw new ValidationError('Unsupported theme');
    change.themeId = input.themeId;
  }
  // Null is a value here — no ceiling — and is distinct from leaving it alone.
  if (input.apiTokenMaxLifetimeDays !== undefined) {
    change.apiTokenMaxLifetimeDays = input.apiTokenMaxLifetimeDays === null
      ? null : apiTokenLifetimeDays(input.apiTokenMaxLifetimeDays, 'apiTokenMaxLifetimeDays');
  }
  if (input.toastSeconds !== undefined) change.toastSeconds = toastSeconds(input.toastSeconds, 'toastSeconds');
  if (input.peopleDirectory !== undefined) {
    if (!(peopleDirectories as readonly unknown[]).includes(input.peopleDirectory)) {
      throw new ValidationError(`peopleDirectory must be one of ${peopleDirectories.join(', ')}`);
    }
    change.peopleDirectory = input.peopleDirectory as PeopleDirectory;
  }
  return change;
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
