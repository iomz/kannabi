import { record, ValidationError } from './identity.js';
import { isThemeId, type ThemeId } from '../shared/theme.js';

export type Settings = { requirePhoto: boolean; displayTimezone: string; themeId: ThemeId };
export function validateSettings(value: unknown): Settings {
  const input = record(value, ['requirePhoto', 'displayTimezone', 'themeId']);
  if (typeof input.requirePhoto !== 'boolean' || typeof input.displayTimezone !== 'string'
      || !isThemeId(input.themeId)) {
    throw new ValidationError('Photo requirement, display timezone, and supported theme are required');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: input.displayTimezone }); }
  catch { throw new ValidationError('Unknown display timezone'); }
  return { requirePhoto: input.requirePhoto, displayTimezone: input.displayTimezone, themeId: input.themeId };
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
