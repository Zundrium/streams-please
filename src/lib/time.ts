export const DEFAULT_TIMEZONE = 'Europe/Amsterdam';

export function localTimezone(fallback = DEFAULT_TIMEZONE): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
}
